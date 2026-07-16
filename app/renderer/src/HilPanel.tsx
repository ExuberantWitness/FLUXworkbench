// HIL panel — natural language → asset-derived test plan → run on mock|real|sim.
// Live step lights come from hil.step bus events; the final report from flux:hilRun.
// History section replays recorded evidence bundles: same lights, recorded data.
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLang } from "./i18n";

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
  const { t } = useLang();
  const [goal, setGoal] = useState("Verify the flashed firmware toggles the PC13 LED and the chip identity is STM32F103");
  const [planText, setPlanText] = useState("");
  const [generated, setGenerated] = useState<boolean | null>(null);
  const [genError, setGenError] = useState("");
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<Report | null>(null);
  const flux = (window as unknown as {
    flux: {
      mcpCall(tool: string, args: Record<string, unknown>): Promise<string>;
      hilGenerate(goal: string, opts: Record<string, unknown>): Promise<{ plan: unknown; generated: boolean; error?: string }>;
      hilRun(plan: unknown): Promise<unknown>;
      evidenceList(): Promise<Array<{ runId: string; verdict: string; createdAt: number; content_hash: string }>>;
      evidenceGet(runId: string): Promise<unknown | null>;
      deviceStatus(): Promise<Array<{ id: string; name: string; chip: string; vid: string; pid: string; present: boolean }>>;
      authorizeUsb(vid: string, pid: string): Promise<{ ok: boolean; error?: string }>;
      probeConnect(boardId: string): Promise<{ ok: boolean; chip?: string; error?: string }>;
    };
  }).flux;

  // ── real device bar (detect → authorize → connect), board-profile driven ──
  const [devices, setDevices] = useState<Array<{ id: string; name: string; chip: string; vid: string; pid: string; present: boolean }>>([]);
  const [devBusy, setDevBusy] = useState("");
  const [connected, setConnected] = useState("");
  const attached = events.filter((e) => e.topic === "device.attached" && (e.data as { real?: boolean }).real).length;
  const scanDevices = async (): Promise<void> => {
    setDevBusy("scan");
    try { setDevices(await flux.deviceStatus()); } finally { setDevBusy(""); }
  };
  useEffect(() => { void scanDevices(); }, []);
  const [authNote, setAuthNote] = useState("");
  const onboard = async (d: { id: string; vid: string; pid: string }): Promise<void> => {
    setDevBusy(`onb-${d.id}`); setAuthNote("");
    try {
      const out = JSON.parse(await flux.mcpCall("onboard_device", { board: d.id }));
      if (out.error) { setAuthNote(`✗ ${out.error}`); return; }
      const svd = (out.steps ?? []).find((x: { step: string }) => x.step === "svd");
      setAuthNote(`✓ ${t("dev.onboarded")}: ${out.chip} · ${svd?.registers ?? 0} regs · SN ${String(out.serial).slice(0, 12)} → ${out.devready_asset}`);
    } catch (e) { setAuthNote(`✗ ${(e as Error).message.slice(0, 120)}`); }
    finally { setDevBusy(""); }
  };
  const [osCaps, setOsCaps] = useState<{ usbScan: boolean; usbAuthorize: boolean } | null>(null);
  useEffect(() => {
    void (window as any).flux?.osInfo?.().then((o: any) => setOsCaps(o.caps)).catch(() => void 0); // eslint-disable-line @typescript-eslint/no-explicit-any
  }, []);
  const authorize = async (d: { id: string; vid: string; pid: string }): Promise<void> => {
    setDevBusy(`auth-${d.vid}`); setAuthNote("");
    try {
      const r = await flux.authorizeUsb(d.vid, d.pid);
      if (r.ok) {
        setAuthNote(`✓ ${d.vid}:${d.pid} ${t("dev.authOk")}`);
        await scanDevices();
        void connect(d.id); // authorize → connect in one flow
      } else {
        setAuthNote(`✗ ${r.error ?? "authorization failed"}`);
      }
    } finally { setDevBusy(""); }
  };
  const connect = async (id: string): Promise<void> => {
    setDevBusy(`conn-${id}`);
    try {
      const r = await flux.probeConnect(id);
      if (r.ok) { setConnected(id); setAuthNote(`✓ ${r.chip} ${t("dev.connected")}`); }
      else setAuthNote(`✗ ${r.error ?? "connect failed"}`);
    } finally { setDevBusy(""); }
  };

  const plan = useMemo(() => {
    try { return JSON.parse(planText); } catch { return null; }
  }, [planText]);

  // ── evidence history + replay (P3) ──
  const [history, setHistory] = useState<Array<{ runId: string; verdict: string; createdAt: number; content_hash: string }>>([]);
  const [replayMap, setReplayMap] = useState<Map<string, string> | null>(null);
  const replayTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const hilReports = events.filter((e) => e.topic === "hil.report").length;
  useEffect(() => {
    void flux.evidenceList?.().then(setHistory).catch(() => void 0);
  }, [hilReports]);
  useEffect(() => () => { if (replayTimer.current) clearInterval(replayTimer.current); }, []);

  const replay = async (runId: string): Promise<void> => {
    const bundle = await flux.evidenceGet(runId) as {
      plan?: unknown;
      events?: Array<{ topic: string; data: { stepId?: string; status?: string } }>;
    } | null;
    if (!bundle) return;
    setReport(null); setGenError("");
    setPlanText(JSON.stringify(bundle.plan, null, 2));
    const steps = (bundle.events ?? []).filter((e) => e.topic === "hil.step");
    if (replayTimer.current) clearInterval(replayTimer.current);
    const m = new Map<string, string>();
    setReplayMap(new Map());
    let i = 0;
    replayTimer.current = setInterval(() => {
      if (i >= steps.length) {
        if (replayTimer.current) clearInterval(replayTimer.current);
        return;
      }
      const s = steps[i++]!;
      if (s.data.stepId) m.set(String(s.data.stepId), String(s.data.status ?? ""));
      setReplayMap(new Map(m));
    }, 350);
  };

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

  const doRun = async (planOverride?: unknown): Promise<void> => {
    const target = planOverride ?? plan;
    if (!target) return;
    setRunning(true); setReport(null); setReplayMap(null);
    if (replayTimer.current) clearInterval(replayTimer.current);
    try {
      setReport(await flux.hilRun(target) as Report);
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
      {/* device bar: detect plugged debuggers, authorize USB, connect real probe */}
      <div style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontWeight: 600, color: "var(--grey-3)" }}>
          {t("dev.title")}
          <button data-guide="dev-scan" className="ft-btn" style={{ marginLeft: "auto" }}
            disabled={devBusy === "scan" || osCaps?.usbScan === false}
            title={osCaps?.usbScan === false ? t("dev.noOsScan") : undefined}
            onClick={() => void scanDevices()}>
            {devBusy === "scan" ? "…" : t("dev.scan")}
          </button>
        </div>
        {devices.length === 0 && <div style={{ fontSize: 10.5, color: "var(--grey-3)" }}>{t("dev.none")}</div>}
        {devices.map((d) => (
          <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: d.present ? "#4caf50" : "var(--grey-2)", flexShrink: 0 }} />
            <span style={{ fontWeight: 500 }}>{d.name}</span>
            <span style={{ color: "var(--grey-3)", fontFamily: "var(--mono)", fontSize: 10 }}>{d.vid}:{d.pid} · {d.chip}</span>
            <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
              {d.present && (
                <>
                  <button data-guide="dev-onboard" className="ft-btn"
                    disabled={devBusy === `onb-${d.id}`} title={t("dev.onboardTip")}
                    onClick={() => void onboard(d)}>{devBusy === `onb-${d.id}` ? "⚡…" : t("dev.onboard")}</button>
                  <button data-guide="dev-authorize" className="ft-btn"
                    disabled={devBusy === `auth-${d.vid}` || osCaps?.usbAuthorize === false}
                    title={osCaps?.usbAuthorize === false ? t("dev.noOsAuth") : t("dev.authTip")}
                    onClick={() => void authorize(d)}>{devBusy === `auth-${d.vid}` ? "🔑…" : t("dev.auth")}</button>
                  <button data-guide="dev-connect" className="chat-send" style={{ padding: "1px 8px", fontSize: 10 }} disabled={devBusy === `conn-${d.id}`}
                    onClick={() => void connect(d.id)}>
                    {connected === d.id ? t("dev.connected") : devBusy === `conn-${d.id}` ? "…" : t("dev.connect")}
                  </button>
                </>
              )}
            </span>
          </div>
        ))}
        {authNote && <div style={{ fontSize: 10.5, color: authNote.startsWith("✓") ? "#2e7d32" : "#b91c1c" }}>{authNote}</div>}
        {attached > 0 && <div style={{ fontSize: 10, color: "#2e7d32" }}>{t("dev.realOn")}</div>}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input className="flux-input" style={{ flex: 1 }} value={goal} onChange={(e) => setGoal(e.target.value)}
          placeholder={t("hil.goalPh")} />
        <button className="chat-send" onClick={() => void doGenerate()}>{t("hil.generate")}</button>
        <button className="chat-send" onClick={() => void loadTemplate()}>{t("hil.template")}</button>
      </div>
      {generated !== null && (
        <div style={{ fontSize: 11, color: generated ? "#4caf50" : "#ff9800" }}>
          {generated ? t("hil.fromAsset") : t("hil.fromTemplate")}
          {plan?.source_assets?.length ? ` · source assets: ${plan.source_assets.join(", ")}` : ""}
          {genError && <span style={{ color: "#f44336" }}> · {genError.slice(0, 160)}</span>}
        </div>
      )}
      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        <textarea className="flux-textarea" style={{ flex: 1 }} value={planText}
          onChange={(e) => setPlanText(e.target.value)} placeholder={t("hil.planPh")} spellCheck={false} />
        <div style={{ width: 300, overflow: "auto", display: "flex", flexDirection: "column", gap: 6 }}>
          <button className="chat-send" disabled={!plan || running} onClick={() => void doRun()}>
            {running ? t("hil.running") : `${t("hil.run")} (${plan?.target?.backend ?? "?"})`}
          </button>
          {plan?.steps?.map((s: { id: string; type: string }) => {
            const st = replayMap?.get(s.id)
              ?? report?.steps.find((r) => r.id === s.id)?.status ?? liveSteps.get(s.id) ?? (running ? "running" : "");
            return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, fontFamily: "var(--mono, monospace)" }}>
                <span style={{ width: 9, height: 9, borderRadius: "50%", background: LIGHT[st] ?? "var(--grey-2)", display: "inline-block" }} />
                <span style={{ width: 70, color: "var(--grey-3)" }}>{s.type}</span>
                <span>{s.id}</span>
                <span style={{ marginLeft: "auto", color: "var(--grey-3)" }}>{st}</span>
              </div>
            );
          })}
          {report && (
            <div className="rp-card" style={{ marginTop: 8 }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: report.summary.verdict === "PASS" ? "#4caf50" : "#f44336" }}>
                {report.summary.verdict === "PASS" ? "✓ PASS" : "✗ FAIL"}
                <span style={{ fontSize: 11, fontWeight: 400, color: "var(--grey-3)", marginLeft: 8 }}>
                  {report.summary.passed}/{report.summary.total} steps · {report.mode} · {report.board}
                </span>
              </div>
              {report.steps.filter((s) => s.assertion).map((s) => (
                <div key={s.id} style={{ fontSize: 10.5, fontFamily: "var(--mono, monospace)", marginTop: 4, color: s.status === "pass" ? "#4caf50" : "#f44336" }}>
                  {s.id}: {s.assertion!.op} expected={JSON.stringify(s.assertion!.expected)} actual={JSON.stringify(s.assertion!.actual)}
                </div>
              ))}
              <div style={{ fontSize: 10, color: "var(--grey-3)", marginTop: 4 }}>{t("hil.reportNote")} · runId {report.runId}</div>
            </div>
          )}

          {/* Evidence history — replay any recorded run (unfakeable demo) */}
          <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 6 }}>
            <div style={{ fontSize: 10.5, fontWeight: 700, color: "var(--grey-3)", marginBottom: 4 }}>{t("hil.history")}</div>
            {history.length === 0 && <div style={{ fontSize: 10.5, color: "var(--grey-3)" }}>{t("hil.noHistory")}</div>}
            {history.slice(0, 8).map((h) => (
              <div key={h.runId} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontFamily: "var(--mono, monospace)", padding: "2px 0" }}>
                <span style={{ color: h.verdict === "PASS" ? "#4caf50" : "#f44336" }}>{h.verdict === "PASS" ? "✓" : "✗"}</span>
                <span title={`sha256 ${h.content_hash}`} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{h.runId}</span>
                <button className="chat-send" style={{ padding: "0 6px", fontSize: 9.5 }} onClick={() => void replay(h.runId)}>{t("hil.replay")}</button>
                <button className="chat-send" style={{ padding: "0 6px", fontSize: 9.5 }} disabled={running}
                  onClick={() => void flux.evidenceGet(h.runId).then((b) => {
                    const p = (b as { plan?: unknown })?.plan;
                    if (p) { setPlanText(JSON.stringify(p, null, 2)); void doRun(p); }
                  })}>{t("hil.rerun")}</button>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
