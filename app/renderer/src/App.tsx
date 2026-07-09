// Flux Studio — VSCode Agents Window 式 UI
// 三栏：LeftSidebar（四层 tab + Customizations）| ChatArea（中央主位）| RightPanel（Flux Insight Loop + Physical Subagents + DevReady Assets）
import { useEffect, useMemo, useState } from "react";

// ── types ──
interface FluxEvent { source: string; kind: string; topic: string; data: Record<string, unknown>; trace_id: string }
interface ChatMsg { role: "user" | "agent"; text: string; codeBlock?: string }
interface DirEntry { name: string; isDir: boolean; ext: string }
interface CondaEnv { name: string; path: string }

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flux: any;
  }
}

type LeftTab = "context" | "session" | "memory" | "explorer";

// ── default project ──
const DEFAULT_PROJECT = "/home/exuber/hpm_sdk/samples/hello_world";

export function App() {
  const [events, setEvents] = useState<FluxEvent[]>([]);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [leftTab, setLeftTab] = useState<LeftTab>("explorer");
  const [projectPath, setProjectPath] = useState(DEFAULT_PROJECT);
  const [fileTree, setFileTree] = useState<DirEntry[]>([]);
  const [activeFile, setActiveFile] = useState("");
  const [fileContent, setFileContent] = useState("");
  const [condaEnvs, setCondaEnvs] = useState<CondaEnv[]>([]);
  const [customOpen, setCustomOpen] = useState<string | null>(null);

  useEffect(() => {
    const off = window.flux?.onEvent?.((e: FluxEvent) => {
      setEvents((p) => [...p.slice(-200), e]);
      if (e.topic === "agent.event" && e.data?.["step"] === "chat") {
        const reply = String(e.data?.["reply"] ?? "");
        const m = reply.match(/```(\w+)?\n([\s\S]*?)```/);
        setChatMsgs((p) => [...p.slice(-100),
          { role: "agent", text: reply, codeBlock: m?.[2] }]);
      }
    });
    return () => { off?.(); };
  }, []);

  // load file tree on projectPath change
  useEffect(() => {
    void window.flux?.readDir?.(projectPath).then((entries: DirEntry[]) => {
      setFileTree(entries);
    }).catch(() => void 0);
  }, [projectPath]);

  // load conda on mount
  useEffect(() => {
    void window.flux?.condaList?.().then((envs: CondaEnv[]) => setCondaEnvs(envs)).catch(() => void 0);
  }, []);

  const state = useMemo(() => deriveState(events), [events]);

  const sendChat = (): void => {
    const text = chatInput.trim();
    if (!text) return;
    setChatMsgs((p) => [...p, { role: "user", text }]);
    setChatInput("");
    void window.flux?.sendChat?.(text);
  };

  const openFile = (name: string): void => {
    const fullPath = `${projectPath}/${name}`;
    setActiveFile(name);
    void window.flux?.readFile?.(fullPath).then((c: string) => setFileContent(c)).catch(() => void 0);
  };

  const saveCode = (code: string): void => {
    if (!activeFile) return;
    void window.flux?.writeFile?.(`${projectPath}/${activeFile}`, code).catch(() => void 0);
  };

  return (
    <div className="shell">
      {/* ── 左侧 ── */}
      <LeftSidebar
        tab={leftTab} setTab={setLeftTab}
        events={events} state={state}
        fileTree={fileTree} activeFile={activeFile} openFile={openFile}
        condaEnvs={condaEnvs}
        customOpen={customOpen} setCustomOpen={setCustomOpen}
      />
      {/* ── 中央 chat ── */}
      <ChatArea
        msgs={chatMsgs} input={chatInput} setInput={setChatInput}
        sendChat={sendChat} fileContent={fileContent} activeFile={activeFile} saveCode={saveCode}
      />
      {/* ── 右侧 ── */}
      <RightPanel events={events} state={state} />
      {/* ── 底部 ── */}
      <Footer state={state} />
    </div>
  );
}

// ═══ Left Sidebar ═══
function LeftSidebar(props: {
  tab: LeftTab; setTab: (t: LeftTab) => void;
  events: FluxEvent[]; state: StudioState;
  fileTree: DirEntry[]; activeFile: string; openFile: (f: string) => void;
  condaEnvs: CondaEnv[];
  customOpen: string | null; setCustomOpen: (s: string | null) => void;
}) {
  const { tab, setTab, events, state, fileTree, activeFile, openFile, condaEnvs, customOpen, setCustomOpen } = props;
  const customSections = [
    { id: "overview", label: "Overview", items: [`kernel: ${state.brainReady ? "ready" : "..."}`, `device: ${state.real ? "REAL" : "mock"}`] },
    { id: "workflow", label: "Workflow", items: state.workflow?.steps.map((s) => `${s.name}: ${s.op}`) ?? ["board-bringup"] },
    { id: "agents", label: "Agents", items: ["openocd-task (C)", "brain-agent (Python)"] },
    { id: "mcp", label: "MCP Servers", items: ["dimos (v2)", "scp (v2)", "OpenPrism (v2)"] },
    { id: "skills", label: "Skills", items: ["characterize", "codegen", "schematic→netlist"] },
    { id: "hooks", label: "Hooks", items: ["before-flash", "after-commit"] },
    { id: "plugins", label: "Plugins", items: ["PlatformIO (v2)", "probe-rs (v2)"] },
    { id: "tools", label: "Tools", items: ["riscv GCC 13.2", "HPM_SDK", "HPM OpenOCD 0.12"] },
  ];
  return (
    <aside className="left-sidebar">
      <div className="ls-tabs">
        {(["context", "session", "memory", "explorer"] as LeftTab[]).map((t) => (
          <div key={t} className={`ls-tab ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>{t}</div>
        ))}
      </div>
      <div className="ls-content">
        {tab === "context" && <ContextPanel state={state} activeFile={activeFile} />}
        {tab === "session" && <SessionPanel events={events} />}
        {tab === "memory" && <MemoryPanel events={events} />}
        {tab === "explorer" && (
          <div>
            {fileTree.length === 0 ? (
              <div className="empty-hint">loading…</div>
            ) : (
              fileTree.map((e) => (
                <div key={e.name}
                  className={`ft-item ${activeFile === e.name ? "active" : ""}`}
                  onClick={() => !e.isDir && openFile(e.name)}>
                  <span>{e.isDir ? "📁" : iconForExt(e.ext)}</span>
                  {e.name}
                </div>
              ))
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
            {customOpen === s.id && s.items.map((item, i) => (
              <div key={i} className="custom-item">
                <span className={`dot-sm ${i === 0 ? "on" : ""}`} />
                {item}
              </div>
            ))}
          </div>
        ))}
      </div>
      {/* Conda */}
      <div className="conda-btn" onClick={() => void window.flux?.condaList?.().then((e: CondaEnv[]) => alert(e.map((x) => x.name).join("\n")))}>
        🐍 {condaEnvs.length > 0 ? (condaEnvs[0]?.name ?? "conda") : "conda"} ({condaEnvs.length})
      </div>
    </aside>
  );
}

function ContextPanel({ state, activeFile }: { state: StudioState; activeFile: string }) {
  return (
    <div>
      <div className="ctx-item"><input type="checkbox" defaultChecked /> 📄 {activeFile || "(no file)"}</div>
      <div className="ctx-item"><input type="checkbox" defaultChecked /> 🔧 openocd-task</div>
      <div className="ctx-item"><input type="checkbox" defaultChecked /> 🧠 brain-agent</div>
      {state.workflow && state.workflow.steps.map((s) => (
        <div key={s.name} className="ctx-item"><input type="checkbox" /> 📦 {s.name}</div>
      ))}
    </div>
  );
}

function SessionPanel({ events }: { events: FluxEvent[] }) {
  const sessions = events.filter((e) => e.topic === "asset.committed");
  return (
    <div>
      <div className="sess-item active">▶ Current Session ({events.length} events)</div>
      {sessions.length > 0 && <div className="sess-item">Session {sessions.length} ({sessions[0]?.trace_id?.slice(0, 8) ?? ""})</div>}
      <div className="sess-item">+ New Session</div>
    </div>
  );
}

function MemoryPanel({ events }: { events: FluxEvent[] }) {
  const assets = events.filter((e) => e.topic === "asset.committed");
  return (
    <div>
      <div className="mem-item"><span className="mem-k">device.attached</span> ×{events.filter((e) => e.topic === "device.attached").length}</div>
      <div className="mem-item"><span className="mem-k">openocd.event</span> ×{events.filter((e) => e.topic === "openocd.event").length}</div>
      <div className="mem-item"><span className="mem-k">asset.committed</span> ×{assets.length}</div>
      <div className="mem-item"><span className="mem-k">alarm</span> ×{events.filter((e) => e.topic.startsWith("alarm")).length}</div>
      <div className="mem-item"><span className="mem-k">workflow.published</span> ×{events.filter((e) => e.topic === "workflow.published").length}</div>
    </div>
  );
}

// ═══ Chat Area (中央主位) ═══
function ChatArea(props: {
  msgs: ChatMsg[]; input: string; setInput: (v: string) => void;
  sendChat: () => void; fileContent: string; activeFile: string; saveCode: (c: string) => void;
}) {
  const { msgs, input, setInput, sendChat, fileContent, activeFile, saveCode } = props;
  return (
    <main className="chat-area">
      <div className="chat-messages">
        {activeFile && fileContent && (
          <div className="chat-code-block">
            <div style={{ fontSize: 10, color: "#888", marginBottom: 4 }}>📄 {activeFile}</div>
            <textarea defaultValue={fileContent.slice(0, 2000)} rows={Math.min(15, fileContent.split("\n").length)} />
            <div className="chat-code-actions">
              <button className="chat-code-btn" onClick={() => saveCode(fileContent)}>Save</button>
            </div>
          </div>
        )}
        {msgs.length === 0 && !activeFile ? (
          <div className="chat-empty">
            <div style={{ fontSize: 28, fontWeight: 200, letterSpacing: "-.02em", marginBottom: 8 }}>Flux Studio</div>
            <div style={{ fontSize: 14 }}>Ask MiniCPM-V 4.6 anything about your hardware project.</div>
            <div style={{ fontSize: 12, marginTop: 4 }}>Or open a file from the Explorer on the left.</div>
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i}>
              <div className={`chat-msg chat-${m.role}`}>
                <span className="chat-role">{m.role === "user" ? "▸" : "⚡"}</span>
                <div>
                  <div className="chat-text">{m.text}</div>
                  {m.codeBlock && (
                    <div className="chat-code-block">
                      <textarea defaultValue={m.codeBlock.slice(0, 3000)} rows={Math.min(15, m.codeBlock.split("\n").length)} />
                      <div className="chat-code-actions">
                        <button className="chat-code-btn" onClick={() => saveCode(m.codeBlock!)}>Save to File</button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>
          ))
        )}
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
      {/* Flux Insight Loop */}
      <div className="rp-section">
        <div className="rp-h">Flux Insight Loop</div>
        <div className="kpi-row">
          <div className="kpi-cell"><div className="lbl">Research</div><div className="nb accent">{events.filter((e) => e.topic === "workflow.published").length}</div></div>
          <div className="kpi-cell"><div className="lbl">Execute</div><div className="nb">{ocdEvents.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Asset</div><div className="nb accent">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Debug</div><div className="nb">{events.filter((e) => e.topic === "alarm.critical").length}</div></div>
        </div>
        <div style={{ fontSize: 10, color: "var(--grey-3)", fontFamily: "var(--mono)" }}>
          research → write → execute → debug
        </div>
      </div>
      {/* Physical Subagents */}
      <div className="rp-section">
        <div className="rp-h">Physical Subagents</div>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.deviceAttached ? "on" : "off"}`} /> C TOOL · {state.real ? "REAL" : "MOCK"}</div>
          <div className="rp-title">openocd-task</div>
          <div className="rp-chips">
            <span className="rp-chip">halt</span><span className="rp-chip">flash</span>
            <span className="rp-chip">mdw</span><span className="rp-chip">reset</span>
          </div>
        </div>
        <div className="rp-card">
          <div className="rp-meta"><span className={`rp-status ${state.brainReady ? "on" : "off"}`} /> PYTHON · MiniCPM-V</div>
          <div className="rp-title">brain-agent</div>
          <div className="rp-chips">
            <span className="rp-chip">characterize</span><span className="rp-chip">codegen</span>
            <span className="rp-chip">schematic</span><span className="rp-chip">chat</span>
          </div>
        </div>
        {ocdEvents.length > 0 && (
          <div style={{ marginTop: 6 }}>
            <div style={{ fontSize: 9, color: "var(--grey-3)", fontFamily: "var(--mono)", textTransform: "uppercase", marginBottom: 4 }}>Recent</div>
            {ocdEvents.map((e, i) => (
              <div key={i} style={{ fontSize: 10, fontFamily: "var(--mono)", color: "var(--grey-3)", padding: "2px 0" }}>
                {String(e.data?.["cmd"] ?? "")} → {String(e.data?.["reply"] ?? "").slice(0, 40)}
              </div>
            ))}
          </div>
        )}
      </div>
      {/* DevReady Assets */}
      <div className="rp-section">
        <div className="rp-h">DevReady Assets</div>
        <div className="kpi-row">
          <div className="kpi-cell"><div className="lbl">Total</div><div className="nb">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Driver</div><div className="nb accent">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Device</div><div className="nb">{assets.length}</div></div>
          <div className="kpi-cell"><div className="lbl">Bench</div><div className="nb">{assets.length}</div></div>
        </div>
        {assets.length === 0 ? (
          <div className="empty-hint">flash to create assets</div>
        ) : (
          assets.map((e, i) => (
            <div key={i} className="rp-card">
              <div className="rp-meta">ASSET · {String(e.data?.["asset_id"] ?? "?")}</div>
              <div className="rp-title" style={{ fontSize: 11 }}>HPM6E00 bringup</div>
              <div style={{ fontSize: 10, color: "var(--grey-3)" }}>
                {(e.data?.["components"] as string[])?.join(" + ") || "profile + driver + bench"}
              </div>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}

// ═══ Footer ═══
function Footer({ state }: { state: StudioState }) {
  return (
    <footer className="footbar">
      <div className="stage">device <b>{state.deviceAttached ? (state.real ? "REAL" : "mock") : "—"}</b></div>
      <span className="arr">→</span>
      <div className="stage">brain <b>{state.brainReady ? "ready" : "..."}</b></div>
      <span className="arr">→</span>
      <div className="stage">assets <b>{state.assets}</b></div>
      <span className="arr">→</span>
      <div className="stage">alarm <b>{state.lastAlarm ? "⚠" : "—"}</b></div>
      <div className="spacer" />
      <div className="stage">openocd: <b>{state.openocdEvents}</b></div>
    </footer>
  );
}

// ── helpers ──
function iconForExt(ext: string): string {
  const m: Record<string, string> = { py: "🐍", ts: "🟦", tsx: "⚛️", c: "🔧", h: "🔧", js: "🟨", json: "📄", md: "📖", yaml: "📄", yml: "📄", proto: "📄", cmakelists: "🔧", sh: "📜" };
  return m[ext.toLowerCase()] || "📄";
}

interface StudioState {
  deviceAttached: boolean; lastAlarm: FluxEvent | undefined; assets: number;
  brainReady: boolean; openocdEvents: number; real: boolean;
  workflow: { name: string; steps: Array<{ name: string; op: string; deps: string[] }> } | undefined;
}

function deriveState(events: FluxEvent[]): StudioState {
  let deviceAttached = false, brainReady = false, real = false, assets = 0, openocdEvents = 0;
  let lastAlarm: FluxEvent | undefined;
  let workflow: StudioState["workflow"] = undefined;
  for (const e of events) {
    if (e.topic === "device.attached") { deviceAttached = true; real = Boolean(e.data?.["real"]); }
    if (e.topic === "device.detached") deviceAttached = false;
    if (e.topic === "brain.ready") brainReady = true;
    if (e.topic === "alarm.critical" || e.topic === "alarm.policy-violation") lastAlarm = e;
    if (e.topic === "asset.committed") assets += 1;
    if (e.topic === "openocd.event") openocdEvents += 1;
    if (e.topic === "workflow.published")
      workflow = { name: String(e.data?.["name"] ?? "?"), steps: (e.data?.["steps"] as Array<{ name: string; op: string; deps: string[] }>) ?? [] };
  }
  return { deviceAttached, brainReady, lastAlarm, assets, openocdEvents, real, workflow };
}
