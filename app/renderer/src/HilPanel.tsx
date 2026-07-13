// HIL panel — natural language → asset-derived test plan → run on mock|real|sim.
// Live step lights come from hil.step bus events; the final report from flux:hilRun.
import React, { useMemo, useState } from "react";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

interface StepResult {
  id: string; type: string; status: string; durationMs: number;
  detail: { raw?: string; value?: number; error?: string };
  assertion?: { op: string; expected: unknown; actual: unknown };
}
interface Report {
  runId: string; planName: string; mode: string; board: string;
  steps: StepResult[];
  summary: { total: number; passed: number; failed: number; verdict: string };
}

const LIGHT: Record<string, string> = {
  pass: "#4caf50", fail: "#f44336", error: "#ff9800", skipped: "#757575", running: "#2196f3",
};

export function HilPanel({ events }: { events: FluxEvent[] }): React.ReactElement {
  const [goal, setGoal] = useState("Verify the flashed firmware toggles the PC13 LED and the chip identity is STM32F103");
  const [planText, setPlanText] = useState("");
  const [generated, setGenerated] = useState<boolean | null>(null);
  const [genError, setGenError] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const flux = (window as unknown as {
    flux: {
      hilGenerate(goal: string, opts: Record<string, unknown>): Promise<{ plan: unknown; generated: boolean; error?: string }>;
      hilRun(plan: unknown): Promise<unknown>;
    };
  }).flux;

  const plan = useMemo(() => {
    try { return JSON.parse(planText); } catch { return null; }
  }, [planText]);

  // Live step statuses for the current run (hil.step events arrive mid-run).
  const liveSteps = useMemo(() => {
    const m = new Map<string, string>();
    for (const e of events) {
      if (e.topic === "hil.step") m.set(String(e.data["stepId"]), String(e.data["status"]));
    }
    return m;
  }, [events]);

  const doGenerate = async (): Promise<void> => {
    setGenError(""); setReport(null); setGenerated(null);
    const r = await flux.hilGenerate(goal, {});
    setPlanText(JSON.stringify(r.plan, null, 2));
    setGenerated(r.generated);
    if (r.error) setGenError(r.error);
  };

  const doRun = async (): Promise<void> => {
    if (!plan) return;
    setRunning(true); setReport(null);
    try {
      setReport(await flux.hilRun(plan) as Report);
    } catch (e) {
      setGenError((e as Error).message);
    } finally {
      setRunning(false);
    }
  };

  const loadTemplate = async (): Promise<void> => {
    const r = await flux.hilGenerate("", { backend: "template" });
    setPlanText(JSON.stringify(r.plan, null, 2));
    setGenerated(false);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, overflow: "auto", height: "100%" }}>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={goal} onChange={(e) => setGoal(e.target.value)}
          placeholder="Describe what the firmware must do…"
          style={{ flex: 1, background: "var(--grey-6, #1e1e1e)", color: "inherit", border: "1px solid #333", borderRadius: 4, padding: "6px 8px", fontSize: 12 }} />
        <button className="chat-send" onClick={() => void doGenerate()}>⚡ Generate Plan</button>
        <button className="chat-send" onClick={() => void loadTemplate()}>📄 Template</button>
      </div>
      {generated !== null && (
        <div style={{ fontSize: 11, color: generated ? "#4caf50" : "#ff9800" }}>
          {generated ? "plan generated from register-map asset" : "(template plan — LLM unavailable)"}
          {plan?.source_assets?.length ? ` · source assets: ${plan.source_assets.join(", ")}` : ""}
          {genError && <span style={{ color: "#f44336" }}> · {genError.slice(0, 160)}</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        <textarea value={planText} onChange={(e) => setPlanText(e.target.value)}
          placeholder='Test plan JSON (flux.hil.plan/v1) — generate one or paste here'
          style={{ flex: 1, fontFamily: "var(--mono, monospace)", fontSize: 11, background: "var(--grey-6, #161616)", color: "inherit", border: "1px solid #333", borderRadius: 4, padding: 8, resize: "none" }} />
        <div style={{ width: 300, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          <button className="chat-send" disabled={!plan || running} onClick={() => void doRun()}>
            {running ? "⏳ Running…" : `▶ Run (${plan?.target?.backend ?? "?"})`}
          </button>
          {plan?.steps?.map((s: { id: string; type: string }) => {
            const st = report?.steps.find((r) => r.id === s.id)?.status ?? liveSteps.get(s.id) ?? (running ? "running" : "");
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontFamily: "var(--mono, monospace)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: LIGHT[st] ?? "#333", display: "inline-block" }} />
                <span style={{ width: 70, color: "#888" }}>{s.type}</span>
                <span>{s.id}</span>
                <span style={{ marginLeft: "auto", color: "#666" }}>{st}</span>
              </div>
            );
          })}
          {report && (
            <div className="rp-card" style={{ marginTop: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: report.summary.verdict === "PASS" ? "#4caf50" : "#f44336" }}>
                {report.summary.verdict === "PASS" ? "✓ PASS" : "✗ FAIL"}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888", marginLeft: 8 }}>
                  {report.summary.passed}/{report.summary.total} steps · {report.mode} · {report.board}
                </span>
              </div>
              {report.steps.filter((s) => s.assertion).map((s) => (
                <div key={s.id} style={{ fontSize: 10.5, fontFamily: "var(--mono, monospace)", marginTop: 4, color: s.status === "pass" ? "#4caf50" : "#f44336" }}>
                  {s.id}: {s.assertion!.op} expected={JSON.stringify(s.assertion!.expected)} actual={JSON.stringify(s.assertion!.actual)}
                </div>
              ))}
              <div style={{ fontSize: 10, color: "#666", marginTop: 4 }}>report committed as hil-report asset · runId {report.runId}</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
