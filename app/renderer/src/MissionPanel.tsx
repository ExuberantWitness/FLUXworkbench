// Mission panel — the golden path front and center (P1.3):
// plug in → identify → ingest → plan → verify → commit, one phase light each.
// Live status streams from mission.milestone bus events; the closing card
// shows the metrics that become one point on the dashboard curve.
import React, { useEffect, useMemo, useState } from "react";
import { useLang } from "./i18n";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

const PHASES = ["identify", "ingest", "plan", "verify", "commit"] as const;

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

interface BoardProfile { id: string; name: string; chip: string; pinmux?: string; svd?: string; usb?: { vid: string; pid: string } }

export function MissionPanel({ events }: { events: FluxEvent[] }): React.ReactElement {
  const { t } = useLang();
  const [goal, setGoal] = useState("Characterize the board and build a DevReady asset");
  const [boards, setBoards] = useState<BoardProfile[]>([]);
  const [boardId, setBoardId] = useState("");
  const [backend, setBackend] = useState("mock");
  const [running, setRunning] = useState(false);
  const [missionId, setMissionId] = useState("");
  const [result, setResult] = useState<MissionResult | null>(null);
  const flux = (window as unknown as {
    flux: {
      missionStart(goal: string, opts: Record<string, unknown>): Promise<MissionResult>;
      boards(): Promise<BoardProfile[]>;
      deviceStatus(): Promise<Array<{ id: string; present: boolean }>>;
    };
  }).flux;

  // Board selector from skills/boards.json; default to a plugged-in device.
  const [presentIds, setPresentIds] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      const bs = await flux.boards().catch(() => []);
      setBoards(bs);
      let pick = bs[0]?.id ?? "";
      try {
        const present = (await flux.deviceStatus()).filter((d) => d.present).map((d) => d.id);
        setPresentIds(present);
        if (present.length) pick = present[0]!;
      } catch { /* lsusb unavailable */ }
      setBoardId(pick);
    })();
  }, []);
  const board = boards.find((b) => b.id === boardId);

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

  const start = async (): Promise<void> => {
    setRunning(true); setResult(null);
    // The kernel assigns the real id; clear filter until the result returns.
    setMissionId("");
    try {
      // board-aware: pass chip + board id + its pinmux/svd source so the golden
      // path characterizes the RIGHT device (not the STM32 default).
      const opts: Record<string, unknown> = { backend };
      if (board) {
        opts["chip"] = board.chip;
        opts["board"] = board.id;
        // only a real filesystem path counts (boards.json may hold a descriptive
        // svd string like "STM32F103xx (ingest_svd)"); pinmux is always a path.
        if (board.svd?.includes("/")) opts["svdPath"] = board.svd;
        else if (board.pinmux) opts["pinmuxPath"] = board.pinmux;
      }
      const r = await flux.missionStart(goal, opts);
      setResult(r); setMissionId(r.missionId);
    } catch (e) {
      setResult({ missionId: "", error: (e as Error).message });
    } finally {
      setRunning(false);
    }
  };

  const seconds = (ms?: number): string => (ms ? `${(ms / 1000).toFixed(1)}s` : "—");

  // (First-run guidance now lives in the desk pet — bottom right.)
  // data-* attrs = live panel state for the pet's preflight rules (read at hover time).
  return (
    <div data-board={boardId} data-backend={backend} data-present={presentIds.join(",")}
      style={{ display: "flex", flexDirection: "column", gap: 10, padding: 16, height: "100%", overflow: "auto" }}>
      <div style={{ fontSize: 12, color: "var(--grey-3)", fontWeight: 600 }}>{t("mission.head")}</div>
      <div style={{ display: "flex", gap: 6 }}>
        <input data-guide="mission-goal" className="flux-input" style={{ flex: 1 }} value={goal}
          onChange={(e) => setGoal(e.target.value)} placeholder={t("mission.goalPh")} />
        <button className="chat-send" data-guide="mission-start" disabled={running || !goal.trim()} onClick={() => void start()}>
          {running ? t("mission.running") : t("mission.start")}
        </button>
      </div>
      <div style={{ display: "flex", gap: 6, fontSize: 11, alignItems: "center" }}>
        <span style={{ color: "var(--grey-3)" }}>{t("mission.board")}</span>
        <select className="flux-select" style={{ flex: 1 }} value={boardId} onChange={(e) => setBoardId(e.target.value)}>
          {boards.length === 0 && <option value="">(no boards.json)</option>}
          {boards.map((b) => <option key={b.id} value={b.id}>{b.name} · {b.chip}</option>)}
        </select>
        <select className="flux-select" value={backend} onChange={(e) => setBackend(e.target.value)} title="backend">
          {["mock", "sim", "real"].map((b) => <option key={b}>{b}</option>)}
        </select>
      </div>
      {board && (
        <div style={{ fontSize: 10, color: "var(--grey-3)" }}>
          {board.svd?.includes("/") ? "SVD" : board.pinmux ? t("mission.viaPinmux") : t("mission.viaRegmap")}
          {backend !== "real" && (board.pinmux && !board.svd?.includes("/")) ? ` · ${t("mission.charOnly")}` : ""}
        </div>
      )}

      {/* The one road: five phase lights */}
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
