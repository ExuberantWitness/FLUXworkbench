// Mission panel — the golden path front and center (P1.3):
// plug in → identify → ingest → plan → verify → commit, one phase light each.
// Live status streams from mission.milestone bus events; the closing card
// shows the metrics that become one point on the dashboard curve.
import React, { useEffect, useMemo, useState } from "react";
import { useLang } from "./i18n";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

const PHASES = ["identify", "ingest", "plan", "verify", "commit", "bind"] as const;

const LIGHT: Record<string, string> = {
  done: "#4caf50", fail: "#f44336", start: "#2196f3",
};

interface MissionResult {
  missionId: string;
  record?: {
    verdict?: string; timeToDevreadyMs?: number;
    assetHits?: number; toolCalls?: number;
  };
  report?: { summary?: { passed?: number; total?: number; verdict?: string } };
  planGenerated?: boolean;
  error?: string;
}

interface ResolvedInfo { board?: string; backend?: string; why?: string }

export function MissionPanel({ events }: { events: FluxEvent[] }): React.ReactElement {
  const { t } = useLang();
  const [running, setRunning] = useState(false);
  const [missionId, setMissionId] = useState("");
  const [result, setResult] = useState<(MissionResult & { resolved?: ResolvedInfo }) | null>(null);
  const flux = (window as unknown as {
    flux: { missionStart(goal: string, opts: Record<string, unknown>): Promise<MissionResult & { resolved?: ResolvedInfo }> };
  }).flux;

  // Latest status per phase for the current mission (mission.milestone events).
  const phaseStatus = useMemo(() => {
    const m = new Map<string, { status: string; detail: string }>();
    for (const e of events) {
      if (e.topic !== "mission.milestone" || (missionId && e.trace_id !== missionId)) continue;
      const d = e.data as { phase?: string; status?: string; detail?: string };
      if (d.phase && d.phase !== "mission") {
        m.set(d.phase, { status: d.status ?? "", detail: d.detail ?? "" });
      }
    }
    return m;
  }, [events, missionId]);

  // Synchronous re-entrancy guard: `running` is async state, so a held-Enter
  // auto-repeat can fire start() again before it flips. A ref blocks that.
  const startingRef = React.useRef(false);
  const start = async (): Promise<void> => {
    if (startingRef.current) return;
    startingRef.current = true;
    setRunning(true); setResult(null);
    // The kernel assigns the real id; clear filter until the result returns.
    setMissionId("");
    try {
      // No dropdowns: the kernel auto-resolves board + backend from what's
      // plugged in and the goal's own words. Just send intent.
      const r = await flux.missionStart("Characterize the connected board and build a DevReady asset", {});
      setResult(r); setMissionId(r.missionId);
    } catch (e) {
      setResult({ missionId: "", error: (e as Error).message });
    } finally {
      setRunning(false);
      startingRef.current = false;
    }
  };

  const seconds = (ms?: number): string => (ms ? `${(ms / 1000).toFixed(1)}s` : "—");

  // Live elapsed timer while a mission runs, so a slow phase (flashing in
  // verify) shows progress + elapsed instead of looking frozen.
  const [elapsed, setElapsed] = useState(0);
  const runStart = React.useRef(0);
  useEffect(() => {
    if (!running) return;
    runStart.current = Date.now();
    const id = setInterval(() => setElapsed(Date.now() - runStart.current), 200);
    return () => clearInterval(id);
  }, [running]);
  // Which phase is currently in-flight (started, not yet done/fail).
  const activePhase = [...PHASES].reverse().find((p) => phaseStatus.get(p)?.status === "start");
  // Current HIL step during verify (hil.step events carry per-step status).
  const liveHilStep = useMemo(() => {
    const steps = events.filter((e) => e.topic === "hil.step");
    const last = steps[steps.length - 1]?.data as { stepId?: string; type?: string; status?: string } | undefined;
    return last ? `${last.type ?? ""} ${last.stepId ?? ""} · ${last.status ?? ""}` : "";
  }, [events]);

  // (First-run guidance now lives in the desk pet — bottom right.)
  // data-* attrs = live panel state for the pet's preflight rules (read at hover time).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16, height: "100%", overflow: "auto" }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", justifyContent: "center" }}>
        <button className="chat-send" data-guide="mission-start" disabled={running}
          style={{ padding: "10px 28px", fontSize: 13 }} onClick={() => void start()}>
          {running ? t("mission.running") : t("mission.start")}
        </button>
        <span style={{ fontSize: 10.5, color: "var(--grey-3)" }}>{t("mission.autoNote")}</span>
      </div>
      {result?.resolved?.why && (
        <div style={{ fontSize: 10.5, color: "var(--grey-3)" }}>🎯 {t("mission.autoPicked")}: {result.resolved.why}</div>
      )}

      {/* The one road: phase lights */}
      <div style={{ display: "flex", alignItems: "center", gap: 0, marginTop: 14, justifyContent: "center" }}>
        {PHASES.map((p, i) => {
          const st = phaseStatus.get(p);
          const color = st ? (LIGHT[st.status] ?? "var(--grey-2)") : "var(--grey-2)";
          return (
            <React.Fragment key={p}>
              {i > 0 && <div style={{ width: 46, height: 2, background: st ? "#2e7d32" : "var(--border)" }} />}
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 5, width: 92 }}>
                <span style={{
                  width: 18, height: 18, borderRadius: "50%", background: color,
                  boxShadow: st?.status === "start" ? `0 0 8px ${color}` : "none",
                  transition: "background .3s",
                }} />
                <span style={{ fontSize: 11, color: st ? "var(--ink)" : "var(--grey-3)", fontWeight: st ? 600 : 400 }}>{t(`mission.${p}`)}</span>
                <span style={{ fontSize: 9.5, color: "var(--grey-3)", textAlign: "center", minHeight: 24, maxWidth: 100, overflow: "hidden" }}>
                  {st?.detail?.slice(0, 60) ?? ""}
                </span>
              </div>
            </React.Fragment>
          );
        })}
      </div>

      {running && activePhase && (
        <div style={{ alignSelf: "center", marginTop: 6, fontSize: 11, color: "var(--accent)", display: "flex", alignItems: "center", gap: 8 }}>
          <span className="pet-face" style={{ fontSize: 13, animation: "none" }}>⏳</span>
          <span>{t(`mission.${activePhase}`)} · {(elapsed / 1000).toFixed(1)}s
            {activePhase === "verify" && liveHilStep ? ` · ${liveHilStep}` : ""}</span>
        </div>
      )}

      {result && (
        <div className="rp-card" style={{ marginTop: 10, alignSelf: "center", minWidth: 420 }}>
          {result.error ? (
            <div style={{ color: "#f44336" }}>✗ {result.error.slice(0, 200)}</div>
          ) : (
            <>
              <div style={{ fontSize: 16, fontWeight: 700, color: result.record?.verdict === "PASS" ? "#4caf50" : "#f44336" }}>
                {result.record?.verdict === "PASS" ? "✓ DevReady" : `✗ ${result.record?.verdict ?? "FAIL"}`}
                <span style={{ fontSize: 11, fontWeight: 400, color: "#888", marginLeft: 10 }}>
                  {t("mission.time")} {seconds(result.record?.timeToDevreadyMs)}
                </span>
              </div>
              <div style={{ fontSize: 11, color: "#aaa", marginTop: 6, display: "flex", gap: 16 }}>
                <span>{t("mission.steps")}: {result.report?.summary?.passed}/{result.report?.summary?.total}</span>
                <span>{t("mission.assets")}: {result.record?.assetHits ?? 0}</span>
                <span>{t("mission.tools")}: {result.record?.toolCalls ?? 0}</span>
                <span>{result.planGenerated ? t("mission.planAsset") : t("mission.planTpl")}</span>
              </div>
              <div style={{ fontSize: 10, color: "#666", marginTop: 6 }}>{t("mission.note")} · {result.missionId}</div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
