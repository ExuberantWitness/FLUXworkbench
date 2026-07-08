// Flux Workbench studio shell — VSCode-style layout + Monaco editor + live uORB state + agent chat.
import { useEffect, useMemo, useState } from "react";
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
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flux: any;
  }
}

const DEFAULT_CODE = `# Flux Workbench — scratch buffer
# Edit firmware / driver / workflow code here.

def read_hpm_id():
    return 0xDEADBEEF
`;

export function App() {
  const [events, setEvents] = useState<FluxEvent[]>([]);
  const [chatMsgs, setChatMsgs] = useState<ChatMsg[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [panelTab, setPanelTab] = useState<"events" | "chat">("events");

  useEffect(() => {
    const off = window.flux?.onEvent?.((e: FluxEvent) => {
      setEvents((prev) => [...prev.slice(-200), e]);
      // route chat replies to chat panel
      if (e.topic === "agent.event" && e.data?.["step"] === "chat") {
        setChatMsgs((prev) => [
          ...prev.slice(-100),
          { role: "user", text: String(e.data?.["user"] ?? "") },
          { role: "agent", text: String(e.data?.["reply"] ?? "") },
        ]);
      }
    });
    return () => off?.();
  }, []);

  const state = useMemo(() => deriveState(events), [events]);

  const sendChat = (): void => {
    const text = chatInput.trim();
    if (!text) return;
    setChatMsgs((prev) => [...prev, { role: "user", text }]);
    setChatInput("");
    void window.flux?.sendChat?.(text);
  };

  return (
    <div className="shell">
      <ActivityBar />
      <Sidebar state={state} />
      <EditorArea />
      <Panel
        events={events}
        chatMsgs={chatMsgs}
        chatInput={chatInput}
        setChatInput={setChatInput}
        sendChat={sendChat}
        panelTab={panelTab}
        setPanelTab={setPanelTab}
      />
      <StatusBar state={state} />
    </div>
  );
}

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

function ActivityBar() {
  return <nav className="activity-bar" aria-label="activity" />;
}

function Sidebar({ state }: { state: StudioState }) {
  return (
    <aside className="sidebar">
      <div className="side-section">
        <div className="side-h">kernel peers</div>
        <Peer label="brain" on={state.brainReady} />
        <Peer label={`openocd ${state.real ? "●" : "(mock)"}`} on={state.deviceAttached} />
      </div>
      <div className="side-section">
        <div className="side-h">devready assets</div>
        <div className="side-val">{state.assets} committed</div>
      </div>
      {state.workflow && (
        <div className="side-section">
          <div className="side-h">workflow · {state.workflow.name}</div>
          <ol className="wf-steps">
            {state.workflow.steps.map((s) => (
              <li key={s.name} className="wf-step">
                <span className="wf-name">{s.name}</span>
                <span className="wf-op">{s.op}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </aside>
  );
}

function Peer({ label, on }: { label: string; on: boolean }) {
  return (
    <div className={`peer ${on ? "on" : "off"}`}>
      <span className="dot" /> {label}
    </div>
  );
}

function EditorArea() {
  return (
    <main className="editor">
      <Editor
        height="100%"
        defaultLanguage="python"
        defaultValue={DEFAULT_CODE}
        theme="vs-dark"
        options={{ minimap: { enabled: false }, fontSize: 13 }}
      />
    </main>
  );
}

interface PanelProps {
  events: FluxEvent[];
  chatMsgs: ChatMsg[];
  chatInput: string;
  setChatInput: (v: string) => void;
  sendChat: () => void;
  panelTab: "events" | "chat";
  setPanelTab: (v: "events" | "chat") => void;
}

function Panel(props: PanelProps) {
  const { events, chatMsgs, chatInput, setChatInput, sendChat, panelTab, setPanelTab } = props;
  const shown = [...events].reverse();
  return (
    <section className="panel">
      <div className="panel-tabs">
        <button className={`panel-tab-btn ${panelTab === "events" ? "active" : ""}`} onClick={() => setPanelTab("events")}>uORB events</button>
        <button className={`panel-tab-btn ${panelTab === "chat" ? "active" : ""}`} onClick={() => setPanelTab("chat")}>agent chat</button>
      </div>
      {panelTab === "events" ? (
        <ul className="event-stream">
          {shown.map((e, i) => (
            <li key={events.length - i} className={`event event-${e.kind}`}>
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
              <div key={i} className={`chat-msg chat-${m.role}`}>
                <span className="chat-role">{m.role === "user" ? "▸" : "⚡"}</span>
                <span className="chat-text">{m.text}</span>
              </div>
            ))}
            {chatMsgs.length === 0 && <div className="chat-empty">(type a message to talk to MiniCPM-V 4.6…)</div>}
          </div>
          <div className="chat-input-row">
            <input
              className="chat-input"
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") sendChat(); }}
              placeholder="ask MiniCPM-V 4.6..."
            />
            <button className="chat-send" onClick={sendChat}>Send</button>
          </div>
        </div>
      )}
    </section>
  );
}

function StatusBar({ state }: { state: StudioState }) {
  const last = state.lastAlarm;
  return (
    <footer className="status-bar">
      <span>Flux Workbench v2</span>
      <span className={state.deviceAttached ? "ok" : "muted"}>
        ● device {state.deviceAttached ? (state.real ? "REAL" : "mock") : "—"}
      </span>
      <span className={state.brainReady ? "ok" : "muted"}>
        brain {state.brainReady ? "ready" : "..."}
      </span>
      {last && <span className="alarm">⚠ {last.topic}</span>}
      <span className="spacer" />
      <span className="muted">openocd: {state.openocdEvents} events</span>
      <span className="muted">assets: {state.assets}</span>
    </footer>
  );
}
