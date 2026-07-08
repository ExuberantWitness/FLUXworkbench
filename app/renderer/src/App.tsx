// Flux Workbench — Swiss/IKB themed studio (参 flux-runtime/ui/index.html)
// 文件树 + Monaco 编辑器 + 事件流 + agent chat（含代码自动插入编辑器）
import { useEffect, useMemo, useState, useRef } from "react";
import Editor from "@monaco-editor/react";

interface FluxEvent {
  source: string;
  kind: string;
  topic: string;
  data: Record<string, unknown>;
  trace_id: string;
}

interface ChatMsg {
  role: "user" | "agent";
  text: string;
  codeBlock?: string;
}

// ── 虚拟项目文件树（可扩展为真实文件系统）──
const FILE_TREE = [
  { name: "brain", icon: "📁", children: [
    { name: "session.py", icon: "🐍" },
    { name: "workflow.py", icon: "🐍" },
    { name: "bus_ipc.py", icon: "🐍" },
    { name: "llm_vllm.py", icon: "🐍" },
    { name: "asset_store.py", icon: "🐍" },
    { name: "codegen.py", icon: "🐍" },
    { name: "policy_gate.py", icon: "🐍" },
  ]},
  { name: "app", icon: "📁", children: [
    { name: "main/index.ts", icon: "🟦" },
    { name: "kernel/scheduler.ts", icon: "🟦" },
    { name: "kernel/bus.ts", icon: "🟦" },
    { name: "kernel/agents/openocd.ts", icon: "🟦" },
    { name: "renderer/App.tsx", icon: "⚛️" },
  ]},
  { name: "native/openocd", icon: "📁", children: [
    { name: "openocd_rpc.c", icon: "🔧" },
    { name: "openocd_cli.c", icon: "🔧" },
  ]},
  { name: "bus/topics", icon: "📁", children: [
    { name: "device.proto", icon: "📄" },
  ]},
  { name: "start.sh", icon: "📜" },
  { name: "USAGE.md", icon: "📖" },
];

const DEFAULT_CODE = `# Flux Workbench — agent 可以在这里写代码
# 在 agent chat 里提问，代码块会自动插入编辑器

def read_hpm_id():
    return 0xDEADBEEF
`;

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flux: any;
  }
}

export function App() {
  const [events, setEvents] = useState<FluxEvent[]>([]);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [panelTab, setPanelTab] = useState<"events" | "chat">("events");
  const [navTab, setNavTab] = useState<"studio" | "subagents" | "assets">("studio");
  const [activeFile, setActiveFile] = useState<string>("scratch.py");
  const [editorCode, setEditorCode] = useState(DEFAULT_CODE);
  const editorRef = useRef<Parameters<NonNullable<Parameters<typeof Editor>[0]["onMount"]>>[0] | null>(null);

  useEffect(() => {
    const off = window.flux?.onEvent?.((e: FluxEvent) => {
      setEvents((prev) => [...prev.slice(-200), e]);
      if (e.topic === "agent.event" && e.data?.["step"] === "chat") {
        const reply = String(e.data?.["reply"] ?? "");
        // 从回复中提取代码块（```...```）
        const codeMatch = reply.match(/```(\w+)?\n([\s\S]*?)```/);
        setChatMsgs((prev) => [
          ...prev.slice(-100),
          { role: "user", text: String(e.data?.["user"] ?? "") },
          { role: "agent", text: reply, codeBlock: codeMatch?.[2] },
        ]);
      }
    });
    return () => off?.();
  }, []);

  const state = useMemo(() => deriveState(events), [events]);

  // agent 代码块 → 插入编辑器
  const insertCode = (code: string): void => {
    setEditorCode(code);
    setNavTab("studio");
    setPanelTab("events");
  };

  const sendChat = (): void => {
    const text = chatInput.trim();
    if (!text) return;
    setChatMsgs((prev) => [...prev, { role: "user", text }]);
    setChatInput("");
    void window.flux?.sendChat?.(text);
  };

  return (
    <div className="shell">
      <TopNav navTab={navTab} setNavTab={setNavTab} state={state} />
      {navTab === "studio" && (
        <>
          <Sidebar state={state} activeFile={activeFile} setActiveFile={setActiveFile} fileTree={FILE_TREE} />
          <main className="editor">
            <Editor
              height="100%"
              language={activeFile.endsWith(".py") ? "python" : activeFile.endsWith(".ts") || activeFile.endsWith(".tsx") ? "typescript" : activeFile.endsWith(".c") ? "c" : "plaintext"}
              value={editorCode}
              theme="vs"  /* 浅色主题（IKB paper 风格）*/
              onChange={(v) => setEditorCode(v ?? "")}
              onMount={(ed) => { editorRef.current = ed; }}
              options={{ minimap: { enabled: false }, fontSize: 13, fontFamily: "JetBrains Mono" }}
            />
          </main>
          <Panel
            events={events}
            chatMsgs={chatMsgs}
            chatInput={chatInput}
            setChatInput={setChatInput}
            sendChat={sendChat}
            panelTab={panelTab}
            setPanelTab={setPanelTab}
            insertCode={insertCode}
          />
        </>
      )}
      {navTab === "subagents" && <SubagentsView state={state} events={events} />}
      {navTab === "assets" && <AssetsView state={state} events={events} />}
      <Footer state={state} />
    </div>
  );
}

// ── 顶部导航 ──
function TopNav({ navTab, setNavTab, state }: { navTab: string; setNavTab: (v: "studio" | "subagents" | "assets") => void; state: StudioState }) {
  return (
    <nav className="topnav">
      <div className="brand"><span className="dot" />FLUX WORKBENCH</div>
      <div className="nav-links">
        <div className={`nl ${navTab === "studio" ? "on" : ""}`} onClick={() => setNavTab("studio")}>Studio</div>
        <div className={`nl ${navTab === "subagents" ? "on" : ""}`} onClick={() => setNavTab("subagents")}>
          Subagents <span className="badge">{state.deviceAttached ? "1" : "—"}</span>
        </div>
        <div className={`nl ${navTab === "assets" ? "on" : ""}`} onClick={() => setNavTab("assets")}>
          Assets <span className="badge">{state.assets}</span>
        </div>
      </div>
      <div className="status">
        <span className={`pulse ${state.brainReady ? "on" : ""}`} />
        <span>{state.brainReady ? "connected" : "offline"}</span>
      </div>
    </nav>
  );
}

// ── 左侧栏 ──
function Sidebar({ state, activeFile, setActiveFile, fileTree }: {
  state: StudioState; activeFile: string; setActiveFile: (f: string) => void; fileTree: typeof FILE_TREE;
}) {
  return (
    <aside className="sidebar">
      <div className="side-section">
        <div className="side-h">kernel peers</div>
        <div className={`peer ${state.brainReady ? "on" : "off"}`}>
          <span className="pdot" /> brain {state.brainReady ? "ready" : "..."}
        </div>
        <div className={`peer ${state.deviceAttached ? "on" : "off"}`}>
          <span className="pdot" /> openocd {state.deviceAttached ? (state.real ? "REAL" : "mock") : "—"}
        </div>
      </div>
      {state.workflow && (
        <div className="side-section">
          <div className="side-h">workflow · {state.workflow.name}</div>
          <ol className="wf-steps">
            {state.workflow.steps.map((s, i) => (
              <li key={s.name} className={`wf-step ${i < 2 ? "done" : ""}`}>
                <span className="wf-name">{s.name}</span>
                <span className="wf-op">{s.op}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div className="side-section">
        <div className="side-h">explorer</div>
        <ul className="file-tree">
          {fileTree.map((item) => (
            <li key={item.name}>
              <div className="ft-item" onClick={() => !("children" in item) && setActiveFile(item.name)}>
                <span className="ft-icon">{item.icon}</span>
                {item.name}
              </div>
              {"children" in item && item.children && (
                <ul className="ft-children">
                  {item.children.map((child) => (
                    <li key={child.name}>
                      <div className={`ft-item ${activeFile === child.name ? "active" : ""}`}
                           onClick={() => setActiveFile(child.name)}>
                        <span className="ft-icon">{child.icon}</span>
                        {child.name}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}

// ── 面板（事件流 + agent chat）──
function Panel(props: {
  events: FluxEvent[]; chatMsgs: ChatMsg[]; chatInput: string;
  setChatInput: (v: string) => void; sendChat: () => void;
  panelTab: "events" | "chat"; setPanelTab: (v: "events" | "chat") => void;
  insertCode: (code: string) => void;
}) {
  const { events, chatMsgs, chatInput, setChatInput, sendChat, panelTab, setPanelTab, insertCode } = props;
  const shown = [...events].reverse();
  return (
    <section className="panel">
      <div className="panel-tabs">
        <button className={`panel-tab-btn ${panelTab === "events" ? "active" : ""}`} onClick={() => setPanelTab("events")}>uORB Events</button>
        <button className={`panel-tab-btn ${panelTab === "chat" ? "active" : ""}`} onClick={() => setPanelTab("chat")}>Agent Chat</button>
      </div>
      {panelTab === "events" ? (
        <ul className="event-stream">
          {shown.map((e, i) => (
            <li key={events.length - i} className={`event ${e.kind === "error" ? "err" : ""}`}>
              <span className="ev-topic">{e.topic}</span>
              <span className="ev-source">{e.source}</span>
              <span className="ev-data">{JSON.stringify(e.data).slice(0, 120)}</span>
            </li>
          ))}
          {events.length === 0 && <li className="event empty">(waiting for kernel events…)</li>}
        </ul>
      ) : (
        <div className="chat-panel">
          <div className="chat-messages">
            {chatMsgs.map((m, i) => (
              <div key={i}>
                <div className={`chat-msg chat-${m.role}`}>
                  <span className="chat-role">{m.role === "user" ? "▸" : "⚡"}</span>
                  <div>
                    <div className="chat-text">{m.text}</div>
                    {m.codeBlock && (
                      <div className="chat-code-block" onClick={() => insertCode(m.codeBlock!)}>
                        {m.codeBlock.slice(0, 200)}{m.codeBlock.length > 200 ? "..." : ""}
                        <div className="chat-code-hint">▸ click to insert into editor</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {chatMsgs.length === 0 && (
              <div className="chat-empty">type a message to talk to MiniCPM-V 4.6…</div>
            )}
          </div>
          <div className="chat-input-row">
            <input className="chat-input" type="text" value={chatInput}
                   onChange={(e) => setChatInput(e.target.value)}
                   onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
                   placeholder="ask MiniCPM-V 4.6..." />
            <button className="chat-send" onClick={sendChat}>Send</button>
          </div>
        </div>
      )}
    </section>
  );
}

// ── Subagents 视图 ──
function SubagentsView({ state, events }: { state: StudioState; events: FluxEvent[] }) {
  const ocdEvents = events.filter((e) => e.topic === "openocd.event").slice(-5);
  return (
    <div style={{ gridArea: "editor", padding: "4vh 5vw", overflow: "auto" }}>
      <div className="side-h" style={{ fontSize: "11px" }}>SUBAGENTS · EXECUTE</div>
      <h2 style={{ fontWeight: 300, fontSize: 28, letterSpacing: "-.018em", marginTop: 8 }}>Embodied Agents</h2>
      <div style={{ marginTop: 16 }}>
        <div className="card outlined accent-top">
          <div className="card-meta">C TOOL · {state.real ? "REAL BOARD" : "MOCK"}</div>
          <div className="card-title">openocd-task</div>
          <div className="card-desc">JTAG debug/flash via TCL RPC · device: {state.deviceAttached ? "HPM6E0 attached" : "—"}</div>
          <div className="chips">
            <span className="chip">halt</span>
            <span className="chip">flash</span>
            <span className="chip">mdw</span>
            <span className="chip">reset</span>
          </div>
        </div>
        <div className="card outlined">
          <div className="card-meta">PYTHON · MiniCPM-V 4.6</div>
          <div className="card-title">brain-agent</div>
          <div className="card-desc">Local LLM characterize · schematic→netlist · codegen</div>
          <div className="chips">
            <span className="chip">characterize</span>
            <span className="chip">schematic</span>
            <span className="chip">codegen</span>
            <span className="chip">chat</span>
          </div>
        </div>
      </div>
      <div style={{ marginTop: 24 }}>
        <div className="side-h">RECENT EVENTS</div>
        {ocdEvents.map((e, i) => (
          <div key={i} className="event">
            <span className="ev-topic">{String(e.data?.["cmd"] ?? e.topic)}</span>
            <span className="ev-source">{e.source}</span>
            <span className="ev-data">{String(e.data?.["reply"] ?? "").slice(0, 80)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Assets 视图 ──
function AssetsView({ state, events }: { state: StudioState; events: FluxEvent[] }) {
  const assets = events.filter((e) => e.topic === "asset.committed");
  return (
    <div style={{ gridArea: "editor", padding: "4vh 5vw", overflow: "auto" }}>
      <div className="side-h" style={{ fontSize: "11px" }}>DEVREADY · FLUXMEME</div>
      <h2 style={{ fontWeight: 300, fontSize: 28, letterSpacing: "-.018em", marginTop: 8 }}>Asset Library</h2>
      <div className="kpi-row" style={{ marginTop: 16, maxWidth: 480 }}>
        <div className="kpi-cell"><div className="lbl">TOTAL</div><div className="nb">{state.assets}</div></div>
        <div className="kpi-cell"><div className="lbl">DEVICE</div><div className="nb accent">{assets.length}</div></div>
        <div className="kpi-cell"><div className="lbl">DRIVER</div><div className="nb">{assets.length}</div></div>
        <div className="kpi-cell"><div className="lbl">BENCH</div><div className="nb">{assets.length}</div></div>
      </div>
      <div style={{ marginTop: 24 }}>
        {assets.length === 0 ? (
          <div style={{ color: "var(--grey-3)", fontWeight: 300, padding: 20, textAlign: "center" }}>
            dispatch a flash to create assets
          </div>
        ) : (
          assets.map((e, i) => (
            <div key={i} className="card outlined accent-top">
              <div className="card-meta">ASSET · {String(e.data?.["asset_id"] ?? "?")}</div>
              <div className="card-title">HPM6E00 bringup bundle</div>
              <div className="card-desc">
                {(e.data?.["components"] as string[])?.join(" + ") || "device-profile + driver + bench"}
                {" · past_assets: "}{String((e.data?.["characterization"] as Record<string, unknown> | undefined)?.["past_assets"] ?? "0")}
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

// ── 底部状态栏 ──
function Footer({ state }: { state: StudioState }) {
  return (
    <footer className="footbar">
      <div className="stage">device <b>{state.deviceAttached ? (state.real ? "REAL" : "mock") : "—"}</b></div>
      <span className="arr">→</span>
      <div className="stage">brain <b>{state.brainReady ? "ready" : "..."}</b></div>
      <span className="arr">→</span>
      <div className="stage">assets <b>{state.assets}</b></div>
      <span className="arr">→</span>
      <div className="stage">alarm <b>{state.lastAlarm ? "⚠ " + String(state.lastAlarm.data?.["code"] ?? "") : "—"}</b></div>
      <div className="spacer" />
      <div className="stage">openocd: <b>{state.openocdEvents}</b></div>
    </footer>
  );
}

// ── 状态推导 ──
interface StudioState {
  deviceAttached: boolean;
  lastAlarm: FluxEvent | undefined;
  assets: number;
  brainReady: boolean;
  openocdEvents: number;
  workflow: { name: string; steps: Array<{ name: string; op: string; deps: string[] }> } | undefined;
  real: boolean;
}

function deriveState(events: FluxEvent[]): StudioState {
  let deviceAttached = false;
  let brainReady = false;
  let lastAlarm: FluxEvent | undefined;
  let assets = 0;
  let openocdEvents = 0;
  let workflow: StudioState["workflow"] = undefined;
  let real = false;
  for (const e of events) {
    if (e.topic === "device.attached") { deviceAttached = true; real = Boolean(e.data?.["real"]); }
    if (e.topic === "device.detached") deviceAttached = false;
    if (e.topic === "brain.ready") brainReady = true;
    if (e.topic === "alarm.critical" || e.topic === "alarm.policy-violation") lastAlarm = e;
    if (e.topic === "asset.committed") assets += 1;
    if (e.topic === "openocd.event") openocdEvents += 1;
    if (e.topic === "workflow.published")
      workflow = {
        name: String(e.data?.["name"] ?? "?"),
        steps: (e.data?.["steps"] as Array<{ name: string; op: string; deps: string[] }>) ?? [],
      };
  }
  return { deviceAttached, brainReady, lastAlarm, assets, openocdEvents, workflow, real };
}
