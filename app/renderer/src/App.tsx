// Flux Studio — functional UI for user testing
// 三栏：LeftSidebar（Session/Memory/Explorer + Customizations）| ChatArea（中央）| RightPanel
import { useEffect, useMemo, useState, useCallback } from "react";

interface FluxEvent { source: string; kind: string; topic: string; data: Record<string, unknown>; trace_id: string }
interface ChatMsg { role: "user" | "agent"; text: string; codeBlock?: string }
interface DirEntry { name: string; isDir: boolean; ext: string }
interface CondaEnv { name: string; path: string }

declare global {
  interface Window { flux: any; } // eslint-disable-line @typescript-eslint/no-explicit-any
}

type LeftTab = "session" | "memory" | "explorer";
const DEFAULT_PROJECT = "/home/exuber/hpm_sdk/samples/hello_world";

// ── File tree node ──
interface TreeNode {
  name: string;
  path: string;
  isDir: boolean;
  ext: string;
  children?: TreeNode[];
  loaded?: boolean;
  expanded?: boolean;
}

export function App() {
  const [events, setEvents] = useState<FluxEvent[]>([]);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [leftTab, setLeftTab] = useState<LeftTab>("explorer");
  const [projectPath, setProjectPath] = useState(DEFAULT_PROJECT);
  const [treeRoot, setTreeRoot] = useState<TreeNode[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [activeFilePath, setActiveFilePath] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [condaEnvs, setCondaEnvs] = useState<CondaEnv[]>([]);
  const [condaActive, setCondaActive] = useState("base");
  const [condaDropdown, setCondaDropdown] = useState(false);
  const [customOpen, setCustomOpen] = useState<string | null>("overview");
  const [sessionList, setSessionList] = useState<{ id: string; msgCount: number }[]>([
    { id: "current", msgCount: 0 },
  ]);
  const [activeSession, setActiveSession] = useState("current");
  const [apiConfig, setApiConfig] = useState({
    provider: "vllm" as "vllm" | "openai" | "anthropic",
    endpoint: "http://127.0.0.1:8000",
    apiKey: "",
    model: "openbmb/MiniCPM-V-4.6",
  });

  useEffect(() => {
    const off = window.flux?.onEvent?.((e: FluxEvent) => {
      setEvents((p) => [...p.slice(-200), e]);
      if (e.topic === "agent.event" && e.data?.["step"] === "chat") {
        const reply = String(e.data?.["reply"] ?? "(no reply)");
        const m = reply.match(/```(\w+)?\n([\s\S]*?)```/);
        setChatMsgs((p) => [...p.slice(-100), { role: "agent", text: reply, codeBlock: m?.[2] }]);
        setSessionList((p) => p.map((s) => s.id === activeSession ? { ...s, msgCount: p.length } : s));
      }
    });
    return () => off?.();
  }, [activeSession]);

  // Load root file tree
  const loadDir = useCallback(async (dirPath: string): Promise<TreeNode[]> => {
    try {
      const entries: DirEntry[] = await window.flux?.readDir?.(dirPath);
      return entries.map((e) => ({
        name: e.name,
        path: `${dirPath}/${e.name}`,
        isDir: e.isDir,
        ext: e.ext,
        children: e.isDir ? [] : undefined,
        loaded: !e.isDir,
        expanded: false,
      }));
    } catch { return []; }
  }, []);

  useEffect(() => {
    void loadDir(projectPath).then(setTreeRoot);
  }, [projectPath, loadDir]);

  useEffect(() => {
    void window.flux?.condaList?.().then((envs: CondaEnv[]) => {
      setCondaEnvs(envs);
      const base = envs.find((e) => e.name === "base");
      if (base) setCondaActive("base");
    }).catch(() => void 0);
  }, []);

  const state = useMemo(() => deriveState(events), [events]);

  // ── Folder expand/collapse ──
  const toggleFolder = async (node: TreeNode): Promise<void> => {
    if (!node.isDir) return;
    if (!node.loaded) {
      node.children = await loadDir(node.path);
      node.loaded = true;
    }
    node.expanded = !node.expanded;
    setTreeRoot([...treeRoot]);
  };

  // ── Open file ──
  const openFile = async (node: TreeNode): Promise<void> => {
    if (node.isDir) return;
    setActiveFile(node.name);
    setActiveFilePath(node.path);
    try {
      const content: string = await window.flux?.readFile?.(node.path);
      setFileContent(content);
    } catch { setFileContent("(cannot read)"); }
  };

  // ── Save file ──
  const saveFile = async (content: string): Promise<void> => {
    if (!activeFilePath) return;
    await window.flux?.writeFile?.(activeFilePath, content);
  };

  // ── Chat ──
  const sendChat = (): void => {
    const text = chatInput.trim();
    if (!text) return;
    setChatMsgs((p) => [...p, { role: "user", text }]);
    setChatInput("");
    void window.flux?.sendChat?.(text);
  };

  // ── New session ──
  const newSession = (): void => {
    const id = `session-${Date.now()}`;
    setSessionList((p) => [...p, { id, msgCount: 0 }]);
    setActiveSession(id);
    setChatMsgs([]);
    setEvents([]);
  };

  return (
    <div className="shell">
      <LeftSidebar
        tab={leftTab} setTab={setLeftTab}
        events={events} state={state}
        treeRoot={treeRoot} toggleFolder={toggleFolder}
        activeFile={activeFile} openFile={openFile}
        customOpen={customOpen} setCustomOpen={setCustomOpen}
        sessionList={sessionList} activeSession={activeSession}
        setActiveSession={setActiveSession} newSession={newSession}
        apiConfig={apiConfig} setApiConfig={setApiConfig}
      />
      <ChatArea
        msgs={chatMsgs} input={chatInput} setInput={setChatInput}
        sendChat={sendChat} fileContent={fileContent} activeFile={activeFile}
        saveFile={saveFile} state={state}
      />
      <RightPanel events={events} state={state} />
      <Footer
        state={state}
        condaEnvs={condaEnvs} condaActive={condaActive}
        setCondaActive={setCondaActive} condaDropdown={condaDropdown}
        setCondaDropdown={setCondaDropdown}
      />
    </div>
  );
}

// ═══ Tree renderer ═══
function TreeView({ nodes, depth, activeFile, toggleFolder, openFile }: {
  nodes: TreeNode[]; depth: number; activeFile: string;
  toggleFolder: (n: TreeNode) => void; openFile: (n: TreeNode) => void;
}) {
  return (
    <ul className="ft-list" style={{ marginLeft: depth > 0 ? 8 : 0 }}>
      {nodes.map((node) => (
        <li key={node.path}>
          <div
            className={`ft-item ${activeFile === node.name ? "active" : ""}`}
            style={{ paddingLeft: depth * 8 }}
            onClick={() => node.isDir ? toggleFolder(node) : openFile(node)}
          >
            <span>{node.isDir ? (node.expanded ? "📂" : "📁") : iconForExt(node.ext)}</span>
            {node.name}
          </div>
          {node.isDir && node.expanded && node.children && (
            <TreeView nodes={node.children} depth={depth + 1} activeFile={activeFile}
              toggleFolder={toggleFolder} openFile={openFile} />
          )}
        </li>
      ))}
    </ul>
  );
}

// ═══ Left Sidebar ═══
function LeftSidebar(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { tab, setTab, events, state, treeRoot, toggleFolder, activeFile, openFile,
    customOpen, setCustomOpen, sessionList, activeSession, setActiveSession, newSession, apiConfig, setApiConfig } = props;
  const customSections = [
    { id: "overview", label: "Overview", items: [`kernel: ${state.brainReady ? "ready" : "..."}`, `device: ${state.real ? "REAL" : "mock"}`] },
    { id: "workflow", label: "Workflow", items: state.workflow?.steps.map((s: any) => `${s.name}: ${s.op}`) ?? ["(none)"] },
    { id: "agents", label: "Agents", items: ["openocd-task (C)", "brain-agent (Python)"] },
    { id: "mcp", label: "MCP Servers", items: ["(v2) dimos", "(v2) scp"] },
    { id: "skills", label: "Skills", items: ["characterize", "codegen", "schematic→netlist"] },
    { id: "hooks", label: "Hooks", items: ["before-flash", "after-commit"] },
    { id: "plugins", label: "Plugins", items: ["(v2) PlatformIO", "(v2) probe-rs"] },
    { id: "tools", label: "Tools", items: ["riscv GCC 13.2", "HPM_SDK", "HPM OpenOCD"] },
    { id: "api", label: "API Config", items: [
      `Provider: ${apiConfig.provider}`,
      `Endpoint: ${apiConfig.endpoint}`,
      `Model: ${apiConfig.model}`,
    ]},
  ];
  return (
    <aside className="left-sidebar">
      <div className="ls-tabs">
        {(["session", "memory", "explorer"] as LeftTab[]).map((t) => (
          <div key={t} className={`ls-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>
      <div className="ls-content">
        {tab === "session" && (
          <div>
            <div style={{ marginBottom: 8, display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 9, fontFamily: "var(--mono)", color: "var(--grey-3)", textTransform: "uppercase" }}>Sessions</span>
              <button className="ls-new-btn" onClick={newSession}>+ New</button>
            </div>
            {sessionList.map((s: { id: string; msgCount: number }) => (
              <div key={s.id}
                className={`sess-item ${activeSession === s.id ? "active" : ""}`}
                onClick={() => setActiveSession(s.id)}>
                {s.id === "current" ? "▶ " : ""}{s.id} ({s.msgCount})
              </div>
            ))}
          </div>
        )}
        {tab === "memory" && <MemoryPanel events={events} />}
        {tab === "explorer" && (
          <div>
            {treeRoot.length === 0 ? (
              <div className="empty-hint">Loading…</div>
            ) : (
              <TreeView nodes={treeRoot} depth={0} activeFile={activeFile}
                toggleFolder={toggleFolder} openFile={openFile} />
            )}
          </div>
        )}
      </div>
      {/* Customizations */}
      <div className="custom-section">
        {customSections.map((s) => (
          <div key={s.id}>
            <div className="custom-h" onClick={() => setCustomOpen(customOpen === s.id ? null : s.id)}>
              {customOpen === s.id ? "▾" : "▸"} {s.label}
            </div>
            {customOpen === s.id && s.items.map((item: string, i: number) => (
              <div key={i} className="custom-item">
                <span className={`dot-sm ${i === 0 ? "on" : ""}`} />
                {item}
              </div>
            ))}
          </div>
        ))}
      </div>
    </aside>
  );
}

function MemoryPanel({ events }: { events: FluxEvent[] }) {
  return (
    <div>
      <div className="mem-item"><span className="mem-k">device.attached</span> ×{events.filter((e) => e.topic === "device.attached").length}</div>
      <div className="mem-item"><span className="mem-k">openocd.event</span> ×{events.filter((e) => e.topic === "openocd.event").length}</div>
      <div className="mem-item"><span className="mem-k">asset.committed</span> ×{events.filter((e) => e.topic === "asset.committed").length}</div>
      <div className="mem-item"><span className="mem-k">alarm</span> ×{events.filter((e) => e.topic.startsWith("alarm")).length}</div>
      <div className="mem-item"><span className="mem-k">workflow</span> ×{events.filter((e) => e.topic === "workflow.published").length}</div>
      <div className="mem-item"><span className="mem-k">agent.event</span> ×{events.filter((e) => e.topic === "agent.event").length}</div>
    </div>
  );
}

// ═══ Chat Area ═══
function ChatArea(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { msgs, input, setInput, sendChat, fileContent, activeFile, saveFile, state } = props;
  return (
    <main className="chat-area">
      <div className="chat-messages">
        {activeFile && fileContent && (
          <div className="chat-code-block">
            <div style={{ fontSize: 10, color: "#888", marginBottom: 4 }}>📄 {activeFile}</div>
            <textarea defaultValue={fileContent.slice(0, 5000)} rows={Math.min(20, fileContent.split("\n").length)} />
            <div className="chat-code-actions">
              <button className="chat-code-btn" onClick={() => saveFile(fileContent)}>Save</button>
            </div>
          </div>
        )}
        {msgs.length === 0 && !activeFile && (
          <div className="chat-empty">
            <div style={{ fontSize: 28, fontWeight: 200, letterSpacing: "-.02em", marginBottom: 8 }}>Flux Studio</div>
            <div style={{ fontSize: 14 }}>
              {state.brainReady ? "Ask MiniCPM-V anything about your hardware project." : "Connecting to brain…"}
            </div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Or open a file from Explorer on the left.</div>
          </div>
        )}
        {msgs.map((m: ChatMsg, i: number) => (
          <div key={i} className={`chat-msg chat-${m.role}`}>
            <span className="chat-role">{m.role === "user" ? "▸" : "⚡"}</span>
            <div>
              <div className="chat-text">{m.text}</div>
              {m.codeBlock && (
                <div className="chat-code-block">
                  <textarea defaultValue={m.codeBlock.slice(0, 5000)} rows={Math.min(15, m.codeBlock.split("\n").length)} />
                  <div className="chat-code-actions">
                    <button className="chat-code-btn" onClick={() => saveFile(m.codeBlock!)}>Save to File</button>
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
      <div className="chat-input-row">
        <input className="chat-input" type="text" value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
          placeholder="Ask MiniCPM-V 4.6…" />
        <button className="chat-send" onClick={sendChat}>Send</button>
      </div>
    </main>
  );
}

// ═══ Right Panel ═══
function RightPanel({ events, state }: { events: FluxEvent[]; state: StudioState }) {
  const ocdEvents = events.filter((e) => e.topic === "openocd.event").slice(-3);
  const assets = events.filter((e) => e.topic === "asset.committed");
  return (
    <aside className="right-panel">
      <div className="rp-section">
        <div className="rp-h">Flux Insight Loop</div>
        <div className="kpi-row">
          <div className="kpi-cell"><div className="lbl">Research</div><div className="nb accent">{events.filter((e) => e.topic === "workflow.published").length}</div></div>
          <div className="kpi-cell"><div className="lbl">Execute</div><div className="nb">{ocdEvents.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Asset</div><div className="nb accent">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Debug</div><div className="nb">{events.filter((e) => e.topic === "alarm.critical").length}</div></div>
        </div>
        <div style={{ fontSize: 10, color: "var(--grey-3)", fontFamily: "var(--mono)" }}>research → write → execute → debug</div>
      </div>
      <div className="rp-section">
        <div className="rp-h">Physical Subagents</div>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.deviceAttached ? "on" : "off"}`} /> C · {state.real ? "REAL" : "MOCK"}</div>
          <div className="rp-title">openocd-task</div>
          <div className="rp-chips"><span className="rp-chip">halt</span><span className="rp-chip">flash</span><span className="rp-chip">mdw</span><span className="rp-chip">reset</span></div>
        </div>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.brainReady ? "on" : "off"}`} /> Python · MiniCPM-V</div>
          <div className="rp-title">brain-agent</div>
          <div className="rp-chips"><span className="rp-chip">characterize</span><span className="rp-chip">codegen</span><span className="rp-chip">chat</span></div>
        </div>
        {ocdEvents.map((e, i) => (
          <div key={i} style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--grey-3)", padding: "2px 0" }}>
            {String(e.data?.["cmd"] ?? "")} → {String(e.data?.["reply"] ?? "").slice(0, 40)}
          </div>
        ))}
      </div>
      <div className="rp-section">
        <div className="rp-h">DevReady Assets</div>
        <div className="kpi-row">
          <div className="kpi-cell"><div className="lbl">Total</div><div className="nb">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Driver</div><div className="nb accent">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Device</div><div className="nb">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Bench</div><div className="nb">{assets.length}</div></div>
        </div>
        {assets.length === 0 ? <div className="empty-hint">flash to create assets</div> : assets.map((e, i) => (
          <div key={i} className="rp-card">
            <div className="rp-meta">ASSET · {String(e.data?.["asset_id"] ?? "?")}</div>
            <div className="rp-title" style={{ fontSize: 11 }}>HPM6E00 bringup</div>
            <div style={{ fontSize: 10, color: "var(--grey-3)" }}>{(e.data?.["components"] as string[])?.join(" + ") || "profile + driver + bench"}</div>
          </div>
        ))}
      </div>
    </aside>
  );
}

// ═══ Footer + Conda dropdown ═══
function Footer(props: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const { state, condaEnvs, condaActive, setCondaActive, condaDropdown, setCondaDropdown } = props;
  return (
    <footer className="footbar">
      <div className="stage">device <b>{state.deviceAttached ? (state.real ? "REAL" : "mock") : "—"}</b></div>
      <span className="arr">→</span>
      <div className="stage">brain <b>{state.brainReady ? "ready" : "..."}</b></div>
      <span className="arr">→</span>
      <div className="stage">assets <b>{state.assets}</b></div>
      <div className="spacer" />
      {/* Conda dropdown */}
      <div style={{ position: "relative" }}>
        <div className="stage" style={{ cursor: "pointer" }} onClick={() => setCondaDropdown(!condaDropdown)}>
          🐍 <b>{condaActive}</b> ▾
        </div>
        {condaDropdown && (
          <div className="conda-dropdown">
            {condaEnvs.length === 0 ? (
              <div className="conda-item">(no envs found)</div>
            ) : condaEnvs.map((env: CondaEnv) => (
              <div key={env.name}
                className={`conda-item ${condaActive === env.name ? "active" : ""}`}
                onClick={() => { setCondaActive(env.name); setCondaDropdown(false); }}>
                {condaActive === env.name ? "● " : ""}{env.name}
              </div>
            ))}
          </div>
        )}
      </div>
    </footer>
  );
}

// ── helpers ──
function iconForExt(ext: string): string {
  const m: Record<string, string> = { py: "🐍", ts: "🟦", tsx: "⚛️", c: "🔧", h: "🔧", js: "🟨", json: "📄", md: "📖", yaml: "📄", yml: "📄", proto: "📄", sh: "📜" };
  return m[ext.toLowerCase()] || "📄";
}

interface StudioState {
  deviceAttached: boolean; lastAlarm: FluxEvent | undefined; assets: number;
  brainReady: boolean; openocdEvents: number; real: boolean;
  workflow: { name: string; steps: Array<{ name: string; op: string; deps: string[] }> } | undefined;
}

function deriveState(events: FluxEvent[]): StudioState {
  let deviceAttached = false, brainReady = false, real = false, assets = 0, openocdEvents = 0;
  let lastAlarm: FluxEvent | undefined; let workflow: StudioState["workflow"] = undefined;
  for (const e of events) {
    if (e.topic === "device.attached") { deviceAttached = true; real = Boolean(e.data?.["real"]); }
    if (e.topic === "brain.ready") brainReady = true;
    if (e.topic === "alarm.critical" || e.topic === "alarm.policy-violation") lastAlarm = e;
    if (e.topic === "asset.committed") assets += 1;
    if (e.topic === "openocd.event") openocdEvents += 1;
    if (e.topic === "workflow.published")
      workflow = { name: String(e.data?.["name"] ?? "?"), steps: (e.data?.["steps"] as Array<{ name: string; op: string; deps: string[] }>) ?? [] };
  }
  return { deviceAttached, brainReady, lastAlarm, assets, openocdEvents, real, workflow };
}
