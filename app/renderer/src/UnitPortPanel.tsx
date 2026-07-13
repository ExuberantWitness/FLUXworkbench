// UnitPort native panel — RL training migrated into the studio.
// Templates come from the unitport MCP server; the spec is compiled Qt-free;
// the run itself is a kernel-scheduled subprocess whose stdout events arrive
// on the bus as training.* topics (live metrics below).
import React, { useEffect, useMemo, useState } from "react";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }
interface Template { name: string; backend: string; path: string }

const mono: React.CSSProperties = { fontFamily: "var(--mono, monospace)", fontSize: 11 };

export function UnitPortPanel({ events }: { events: FluxEvent[] }): React.ReactElement {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [specText, setSpecText] = useState("");
  const [issues, setIssues] = useState<string[]>([]);
  const [runId, setRunId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [gpu, setGpu] = useState<{ present: boolean; name?: string; driver?: string; vram?: string; driverOk?: boolean } | null>(null);
  const [installing, setInstalling] = useState(false);
  const flux = (window as unknown as {
    flux: {
      mcpCall(tool: string, args: Record<string, unknown>): Promise<string>;
      trainStart(spec: Record<string, unknown>): Promise<string>;
      trainCancel(runId: string): Promise<boolean>;
      gpuInfo(): Promise<{ present: boolean; name?: string; driver?: string; vram?: string; driverOk?: boolean }>;
      isaacInstall(): Promise<{ ok: boolean; error?: string }>;
      isaacCancel(): Promise<boolean>;
    };
  }).flux;
  useEffect(() => { void flux.gpuInfo().then(setGpu).catch(() => setGpu({ present: false })); }, []);
  const installLog = useMemo(() => events
    .filter((e) => e.topic === "install.progress")
    .map((e) => String(e.data["line"] ?? "")).slice(-8), [events]);
  useEffect(() => {
    if (installLog.some((l) => l.startsWith("[EXIT]"))) setInstalling(false);
  }, [installLog]);

  const loadTemplates = async (): Promise<void> => {
    setBusy("templates"); setError("");
    try { setTemplates(JSON.parse(await flux.mcpCall("up.list_templates", {})) as Template[]); }
    catch (e) { setError((e as Error).message.slice(0, 180)); }
    finally { setBusy(""); }
  };

  const compileTemplate = async (name: string): Promise<void> => {
    setBusy(name); setError(""); setIssues([]);
    try {
      const canvas = JSON.parse(await flux.mcpCall("up.get_template", { name })) as Record<string, unknown>;
      const r = JSON.parse(await flux.mcpCall("up.compile_spec", { canvas })) as { spec: unknown; issues: string[] };
      setSpecText(JSON.stringify(r.spec, null, 2));
      setIssues(r.issues ?? []);
    } catch (e) { setError((e as Error).message.slice(0, 200)); }
    finally { setBusy(""); }
  };

  const startRun = async (): Promise<void> => {
    try { setRunId(await flux.trainStart(JSON.parse(specText) as Record<string, unknown>)); setError(""); }
    catch (e) { setError((e as Error).message.slice(0, 200)); }
  };

  // Live metrics for the current run from bus events
  const metrics = useMemo(() => events
    .filter((e) => e.topic === "training.metrics" && e.data["runId"] === runId)
    .slice(-12), [events, runId]);
  const progress = useMemo(() => [...events].reverse()
    .find((e) => e.topic === "training.progress" && e.data["runId"] === runId), [events, runId]);
  const finished = useMemo(() => events
    .some((e) => e.topic === "training.finished" && e.data["runId"] === runId), [events, runId]);

  return (
    <div style={{ display: "flex", gap: 10, padding: 12, height: "100%", overflow: "hidden", fontSize: 11 }}>
      <div style={{ width: 240, display: "flex", flexDirection: "column", gap: 6, overflow: "auto" }}>
        <button className="chat-send" disabled={busy === "templates"} onClick={() => void loadTemplates()}>
          {busy === "templates" ? "…" : "📦 Load Templates"}
        </button>
        {templates.map((t) => (
          <div key={t.path} className="rp-card" style={{ cursor: "pointer" }} onClick={() => void compileTemplate(t.name)}>
            <div style={{ fontWeight: 600 }}>{busy === t.name ? "compiling…" : t.name}</div>
            <div style={{ color: "#666" }}>{t.backend}</div>
          </div>
        ))}
        {error && <div style={{ color: "#f44336" }}>{error}</div>}

        <div style={{ borderTop: "1px solid #2a2a2a", marginTop: 8, paddingTop: 8 }}>
          <div style={{ color: "#888", fontWeight: 600, marginBottom: 4 }}>ISAAC SIM 6 / ISAACLAB</div>
          {gpu === null ? <div style={{ color: "#555" }}>detecting GPU…</div> : gpu.present ? (
            <div style={{ ...mono, color: gpu.driverOk ? "#4caf50" : "#ff9800" }}>
              ✓ {gpu.name} · {gpu.vram} · driver {gpu.driver}{gpu.driverOk ? "" : " (<580, 建议升级)"}
            </div>
          ) : (
            <div style={{ color: "#f44336" }}>✗ 未检测到 NVIDIA 显卡 — Isaac Sim 需要 RTX GPU</div>
          )}
          <button className="chat-send" style={{ width: "100%", marginTop: 6 }}
            disabled={!gpu?.present || installing}
            onClick={() => { setInstalling(true); void flux.isaacInstall(); }}>
            {installing ? "⏳ Installing… (~10GB)" : "⬇ 一键安装 Isaac Sim 6 + IsaacLab"}
          </button>
          {installing && <button className="chat-send" style={{ width: "100%", marginTop: 4 }}
            onClick={() => void flux.isaacCancel()}>■ Cancel Install</button>}
          {installLog.map((l, i) => (
            <div key={i} style={{ ...mono, fontSize: 10, color: l.startsWith("[ERR]") ? "#f44336" : l.startsWith("[OK]") ? "#4caf50" : "#888", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l}</div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{ color: "#888", fontWeight: 600 }}>TRAINING SPEC
          {issues.length > 0 && <span style={{ color: "#ff9800" }}> · {issues.length} issues</span>}
        </div>
        {issues.slice(0, 3).map((s, i) => <div key={i} style={{ color: "#ff9800" }}>⚠ {s.slice(0, 120)}</div>)}
        <textarea value={specText} onChange={(e) => setSpecText(e.target.value)}
          placeholder="pick a template on the left, or paste a TrainingSpec JSON"
          style={{ flex: 1, ...mono, background: "var(--grey-6, #161616)", color: "inherit", border: "1px solid #333", borderRadius: 4, padding: 8, resize: "none" }} />
        <div style={{ display: "flex", gap: 6 }}>
          <button className="chat-send" disabled={!specText || (!!runId && !finished)} onClick={() => void startRun()}>▶ Train (kernel)</button>
          {runId && !finished && <button className="chat-send" onClick={() => void flux.trainCancel(runId)}>■ Cancel</button>}
        </div>
      </div>

      <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 4, overflow: "auto" }}>
        <div style={{ color: "#888", fontWeight: 600 }}>RUN {runId && <span style={{ color: finished ? "#4caf50" : "#2196f3" }}>{runId} {finished ? "· done" : "· live"}</span>}</div>
        {progress && (
          <div style={mono}>progress: {String((progress.data as Record<string, unknown>)["text"] ?? JSON.stringify(progress.data).slice(0, 80))}</div>
        )}
        {metrics.map((m, i) => (
          <div key={i} style={{ ...mono, color: "#a5d6a7", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {JSON.stringify(m.data).slice(0, 90)}
          </div>
        ))}
        {!runId && <div style={{ color: "#555" }}>training.metrics events stream here once a run starts</div>}
      </div>
    </div>
  );
}
