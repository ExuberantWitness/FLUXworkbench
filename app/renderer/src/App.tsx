// Flux Workbench studio shell — VSCode-style layout skeleton + live uORB event stream.
// Real panels (Monaco editor, agent chat, asset browser, workflow editor) wired later;
// this shows the kernel pipeline is alive inside the Electron shell.
import { useEffect, useState } from "react";

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

export function App() {
  const [events, setEvents] = useState<FluxEvent[]>([]);
  useEffect(() => {
    const off = window.flux?.onEvent?.((e: FluxEvent) =>
      setEvents((prev) => [...prev.slice(-200), e]),
    );
    return () => off?.();
  }, []);

  return (
    <div className="shell">
      <ActivityBar />
      <Sidebar />
      <EditorArea />
      <Panel events={events} />
      <StatusBar events={events} />
    </div>
  );
}

function ActivityBar() {
  return <nav className="activity-bar" aria-label="activity" />;
}
function Sidebar() {
  return <aside className="sidebar">Explorer · assets · workflows · runs</aside>;
}
function EditorArea() {
  return (
    <main className="editor">
      <div className="placeholder">Monaco editor (build-task #5)</div>
    </main>
  );
}

function Panel({ events }: { events: FluxEvent[] }) {
  return (
    <section className="panel">
      <div className="panel-tab">uORB event stream</div>
      <ul className="event-stream">
        {events.map((e, i) => (
          <li key={i} className={`event event-${e.kind}`}>
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

function StatusBar({ events }: { events: FluxEvent[] }) {
  const last = events[events.length - 1];
  return (
    <footer className="status-bar">
      <span>Flux Workbench v2</span>
      <span>{events.length} events</span>
      <span>{last ? `last: ${last.topic}` : "idle"}</span>
    </footer>
  );
}
