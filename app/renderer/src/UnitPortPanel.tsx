// UnitPort native panel — RL training migrated into the studio.
// Templates come from the unitport MCP server; the spec is compiled Qt-free;
// the run itself is a kernel-scheduled subprocess whose stdout events arrive
// on the bus as training.* topics (live metrics below).
import React, { useEffect, useMemo, useState } from "react";
import { useLang } from "./i18n";
import { NodeCanvas, type UpCanvas } from "./NodeCanvas";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }
interface Template { name: string; backend: string; path: string }

const mono: React.CSSProperties = { fontFamily: "var(--mono, monospace)", fontSize: 11 };

export function UnitPortPanel({ events }: { events: FluxEvent[] }): React.ReactElement {
  const { t } = useLang();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [specText, setSpecText] = useState("");
  const [canvas, setCanvas] = useState<UpCanvas | null>(null);
  const [showJson, setShowJson] = useState(false);
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
      trainList(): Promise<Array<{ runId: string; startedAt: number; status: string; live: boolean; resumable: boolean; resumes: number }>>;
      trainResume(runId: string): Promise<string | null>;
      gpuInfo(): Promise<{ present: boolean; name?: string; driver?: string; vram?: string; driverOk?: boolean }>;
      isaacInstall(): Promise<{ ok: boolean; error?: string }>;
      isaacCancel(): Promise<boolean>;
    };
  }).flux;
  useEffect(() => { void flux.gpuInfo().then(setGpu).catch(() => setGpu({ present: false })); }, []);

  // Run history from the persistent registry (survives studio restarts).
  const [history, setHistory] = useState<Array<{ runId: string; status: string; live: boolean; resumable: boolean; resumes: number }>>([]);
  const trainEvents = events.filter((e) => e.topic.startsWith("training.")).length;
  useEffect(() => { void flux.trainList?.().then(setHistory).catch(() => void 0); }, [trainEvents]);
  const doResume = async (id: string): Promise<void> => {
    const r = await flux.trainResume(id);
    if (r) { setRunId(r); setError(""); } else setError(`resume failed: no checkpoint for ${id}`);
  };
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

  // Load a template as an editable node canvas (ComfyUI-style).
  const loadTemplate = async (name: string): Promise<void> => {
    setBusy(name); setError(""); setIssues([]); setSpecText("");
    try {
      setCanvas(JSON.parse(await flux.mcpCall("up.get_template", { name })) as UpCanvas);
    } catch (e) { setError((e as Error).message.slice(0, 200)); }
    finally { setBusy(""); }
  };

  // Compile the (possibly edited) canvas into a TrainingSpec.
  const compileCanvas = async (): Promise<string> => {
    if (!canvas) return "";
    setBusy("compile"); setError(""); setIssues([]);
    try {
      const r = JSON.parse(await flux.mcpCall("up.compile_spec", { canvas })) as { spec: unknown; issues: string[] };
      const text = JSON.stringify(r.spec, null, 2);
      setSpecText(text);
      setIssues(r.issues ?? []);
      return text;
    } catch (e) { setError((e as Error).message.slice(0, 200)); return ""; }
    finally { setBusy(""); }
  };

  const startRun = async (): Promise<void> => {
    try {
      const text = specText || await compileCanvas();
      if (!text) return;
      setRunId(await flux.trainStart(JSON.parse(text) as Record<string, unknown>));
      setError("");
    } catch (e) { setError((e as Error).message.slice(0, 200)); }
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
    <div data-gpu={gpu?.present ? "1" : "0"} data-spec={specText ? "1" : "0"}
      style={{ display: "flex", gap: 10, padding: 12, height: "100%", overflow: "hidden", fontSize: 11 }}>
      <div style={{ width: 240, display: "flex", flexDirection: "column", gap: 6, overflow: "auto" }}>
        <button data-guide="up-load" className="chat-send" disabled={busy === "templates"} onClick={() => void loadTemplates()}>
          {busy === "templates" ? "…" : t("up.load")}
        </button>
        {templates.map((tp, i) => (
          <div key={tp.path} data-guide={i === 0 ? "up-template" : undefined} className="rp-card" style={{ cursor: "pointer" }} onClick={() => void loadTemplate(tp.name)}>
            <div style={{ fontWeight: 600 }}>{busy === tp.name ? t("up.compiling") : tp.name}</div>
            <div style={{ color: "var(--grey-3)" }}>{tp.backend}</div>
          </div>
        ))}
        {error && <div style={{ color: "#f44336" }}>{error}</div>}

        <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 8 }}>
          <div style={{ color: "var(--grey-3)", fontWeight: 600, marginBottom: 4 }}>{t("up.isaac")}</div>
          {gpu === null ? <div style={{ color: "var(--grey-3)" }}>{t("up.detecting")}</div> : gpu.present ? (
            <div style={{ ...mono, color: gpu.driverOk ? "#4caf50" : "#ff9800" }}>
              ✓ {gpu.name} · {gpu.vram} · driver {gpu.driver}{gpu.driverOk ? "" : t("up.driverLow")}
            </div>
          ) : (
            <div style={{ color: "#f44336" }}>{t("up.noGpu")}</div>
          )}
          <button className="chat-send" style={{ width: "100%", marginTop: 6 }}
            disabled={!gpu?.present || installing}
            onClick={() => { setInstalling(true); void flux.isaacInstall(); }}>
            {installing ? t("up.installing") : t("up.install")}
          </button>
          {installing && <button className="chat-send" style={{ width: "100%", marginTop: 4 }}
            onClick={() => void flux.isaacCancel()}>{t("up.cancelInstall")}</button>}
          {installLog.map((l, i) => (
            <div key={i} style={{ ...mono, fontSize: 10, color: l.startsWith("[ERR]") ? "#f44336" : l.startsWith("[OK]") ? "#4caf50" : "#888", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{l}</div>
          ))}
        </div>
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{ color: "var(--grey-3)", fontWeight: 600, display: "flex", alignItems: "center", gap: 8 }}>
          {canvas ? `${String(canvas.backend ?? "")} · ${canvas.nodes?.length ?? 0} nodes · ${canvas.edges?.length ?? 0} edges` : t("up.spec")}
          {issues.length > 0 && <span style={{ color: "#ff9800" }}>· {issues.length} {t("up.issues")}</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button data-guide="up-compile" className="ft-btn" disabled={!canvas || busy === "compile"} onClick={() => void compileCanvas()}>
              {busy === "compile" ? "…" : t("up.compile")}
            </button>
            <button className="ft-btn" onClick={() => setShowJson(!showJson)}>{showJson ? t("up.viewGraph") : "{ }"}</button>
          </span>
        </div>
        {issues.slice(0, 3).map((s, i) => <div key={i} style={{ color: "#ff9800" }}>⚠ {s.slice(0, 120)}</div>)}
        {showJson ? (
          <textarea value={specText || JSON.stringify(canvas ?? {}, null, 2)} onChange={(e) => setSpecText(e.target.value)}
            placeholder={t("up.specPh")}
            className="flux-textarea" style={{ flex: 1 }} spellCheck={false} />
        ) : canvas ? (
          <div style={{ flex: 1, minHeight: 0 }}>
            <NodeCanvas canvas={canvas} onChange={(c) => { setCanvas(c); setSpecText(""); }} />
          </div>
        ) : (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--grey-3)", fontSize: 12, border: "1px dashed var(--grey-2)", borderRadius: 6 }}>
            {t("up.canvasHint")}
          </div>
        )}
        <div style={{ display: "flex", gap: 6 }}>
          <button data-guide="up-train" className="chat-send" disabled={(!canvas && !specText) || (!!runId && !finished)} onClick={() => void startRun()}>{t("up.train")}</button>
          {runId && !finished && <button className="chat-send" onClick={() => void flux.trainCancel(runId)}>{t("up.cancel")}</button>}
        </div>
      </div>

      <div style={{ width: 280, display: "flex", flexDirection: "column", gap: 4, overflow: "auto" }}>
        <div style={{ color: "var(--grey-3)", fontWeight: 600 }}>{t("up.run")} {runId && <span style={{ color: finished ? "#4caf50" : "#2196f3" }}>{runId} {finished ? t("up.done") : t("up.live")}</span>}</div>
        {progress && (
          <div style={mono}>progress: {String((progress.data as Record<string, unknown>)["text"] ?? JSON.stringify(progress.data).slice(0, 80))}</div>
        )}
        {metrics.map((m, i) => (
          <div key={i} style={{ ...mono, color: "#a5d6a7", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {JSON.stringify(m.data).slice(0, 90)}
          </div>
        ))}
        {!runId && <div style={{ color: "var(--grey-3)" }}>{t("up.metricsHint")}</div>}

        {/* Run history + checkpoint resume (registry-backed, survives restart) */}
        <div style={{ borderTop: "1px solid var(--border)", marginTop: 8, paddingTop: 6 }}>
          <div style={{ color: "var(--grey-3)", fontWeight: 600, marginBottom: 4 }}>{t("up.history")}</div>
          {history.length === 0 && <div style={{ color: "var(--grey-3)" }}>{t("up.noHistory")}</div>}
          {history.slice(0, 10).map((h) => (
            <div key={h.runId} style={{ display: "flex", alignItems: "center", gap: 6, ...mono, fontSize: 10, padding: "2px 0" }}>
              <span style={{
                width: 7, height: 7, borderRadius: "50%", flexShrink: 0,
                background: h.live ? "#2196f3" : h.status === "finished" ? "#4caf50" : h.status === "cancelled" ? "#757575" : "#f44336",
              }} />
              <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {h.runId}{h.resumes > 0 ? ` (⏵×${h.resumes})` : ""}
              </span>
              <span style={{ color: "var(--grey-3)" }}>{h.live ? "live" : h.status}</span>
              {h.resumable && (
                <button className="chat-send" style={{ padding: "0 6px", fontSize: 9.5 }}
                  onClick={() => void doResume(h.runId)}>⏵ {t("up.resume")}</button>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
