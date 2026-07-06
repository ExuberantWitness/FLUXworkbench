// Flux Workbench studio shell — VSCode-style layout + Monaco editor + live uORB state.
import { useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";

interface FluxEvent {
  source: string;
  kind: string;
  topic: string;
  data: Record<string, unknown>;
  trace_id: string;
}

declare global {
  interface Window {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    flux: any;
  }
}

const DEFAULT_CODE = `# Flux Workbench — scratch buffer
# Edit firmware / driver / workflow code here.
# (Build-task: wire to a real project file tree + LSP.)

def read_hpm_id():
    return 0xDEADBEEF
`;

export function App() {
  const [events, setEvents] = useState<FluxEvent[]>([]);
  useEffect(() => {
    const off = window.flux?.onEvent?.((e: FluxEvent) =>
      setEvents((prev) => [...prev.slice(-200), e]),
    );
    return () => off?.();
  }, []);

  const state = useMemo(() => deriveState(events), [events]);

  return (
    <div className="shell">
      <ActivityBar />
      <Sidebar state={state} />
      <EditorArea />
      <Panel events={events} />
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
}

function deriveState(events: FluxEvent[]): StudioState {
  let deviceAttached = false;
  let brainReady = false;
  let lastAlarm: FluxEvent | undefined;
  let assets = 0;
  let openocdEvents = 0;
  let workflow: StudioState["workflow"] = undefined;
  for (const e of events) {
    if (e.topic === "device.attached") deviceAttached = true;
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
  return { deviceAttached, brainReady, lastAlarm, assets, openocdEvents, workflow };
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
        <Peer label="openocd" on={state.deviceAttached} />
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

function Panel({ events }: { events: FluxEvent[] }) {
  const shown = [...events].reverse();
  return (
    <section className="panel">
      <div className="panel-tab">uORB event stream</div>
      <ul className="event-stream">
        {shown.map((e, i) => (
          <li key={events.length - i} className={`event event-${e.kind}`}>
            <span className="ev-topic">{e.topic}</span>
            <span className="ev-source">{e.source}</span>
            <span className="ev-data">{JSON.stringify(e.data)}</span>
          </li>
        ))}
        {events.length === 0 && <li className="event empty">(waiting for kernel events…)</li>}
      </ul>
    </section>
  );
}

function StatusBar({ state }: { state: StudioState }) {
  return (
    <footer className="status-bar">
      <span>Flux Workbench v2</span>
      <span className={state.deviceAttached ? "ok" : "muted"}>
        ● device {state.deviceAttached ? "attached" : "—"}
      </span>
      <span className={state.brainReady ? "ok" : "muted"}>
        brain {state.brainReady ? "ready" : "..."}
      </span>
      {state.lastAlarm && <span className="alarm">⚠ {state.lastAlarm.topic}</span>}
      <span className="spacer" />
      <span className="muted">openocd: {state.openocdEvents} events</span>
      <span className="muted">assets: {state.assets}</span>
    </footer>
  );
}
