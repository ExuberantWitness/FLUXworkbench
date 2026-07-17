// Flywheel dashboard (P2) — the product generates its own funding evidence.
// Headline = north-star metric: cumulative DevReady'd devices. Below it the
// two curves ("faster every use"), metering line, corpus counter, and the
// evidence/bench lists. Everything is read live from the asset store.
import React, { useEffect, useMemo, useState } from "react";
import { useLang } from "./i18n";
import { SchedulerViz, type SchedulerState } from "./SchedulerViz";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

interface MissionAsset {
  id: string; ts: number; type: string;
  characterization: {
    goal?: string; verdict?: string; time_to_devready_ms?: number;
    asset_hits?: number; tool_calls?: number; plan_generated?: boolean;
  };
}
interface BenchAsset {
  id: string; ts: number; type: string;
  characterization: { task?: string; model?: string; condition?: string; score?: number; passed?: number; total?: number };
}
interface UsageStats { calls: number; total_in: number; total_out: number; cost_usd: number; saved_pct: number }

/** Minimal inline SVG line chart — no external deps allowed in the studio shell. */
function Curve({ values, labels, color, unit, height = 120 }: {
  values: number[]; labels?: string[]; color: string; unit: string; height?: number;
}): React.ReactElement {
  const w = 380, h = height, pad = 24;
  if (values.length === 0) return <div style={{ color: "var(--grey-3)", fontSize: 11, padding: 12 }}>—</div>;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => {
    const x = pad + (values.length === 1 ? (w - 2 * pad) / 2 : (i * (w - 2 * pad)) / (values.length - 1));
    const y = h - pad - (v / max) * (h - 2 * pad);
    return { x, y, v };
  });
  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <line x1={pad} y1={h - pad} x2={w - pad} y2={h - pad} stroke="var(--grey-2)" />
      <line x1={pad} y1={pad} x2={pad} y2={h - pad} stroke="var(--grey-2)" />
      <polyline fill="none" stroke={color} strokeWidth={2}
        points={pts.map((p) => `${p.x},${p.y}`).join(" ")} />
      {pts.map((p, i) => (
        <g key={i}>
          <circle cx={p.x} cy={p.y} r={3.5} fill={color} />
          <text x={p.x} y={p.y - 8} fontSize={9} fill="var(--grey-3)" textAnchor="middle">{Math.round(p.v * 10) / 10}{unit}</text>
          {labels?.[i] && <text x={p.x} y={h - pad + 12} fontSize={8.5} fill="var(--grey-3)" textAnchor="middle">{labels[i]}</text>}
        </g>
      ))}
    </svg>
  );
}

export function DashboardPanel({ events, schedState }: { events: FluxEvent[]; schedState?: SchedulerState | null }): React.ReactElement {
  const { t } = useLang();
  const [missions, setMissions] = useState<MissionAsset[]>([]);
  const [bench, setBench] = useState<BenchAsset[]>([]);
  const [evidence, setEvidence] = useState<Array<{ id: string; ts: number }>>([]);
  const [usage, setUsage] = useState<UsageStats | null>(null);
  const [traj, setTraj] = useState<{ missions: number; lines: number }>({ missions: 0, lines: 0 });
  const flux = (window as unknown as {
    flux: {
      mcpCall(tool: string, args: Record<string, unknown>): Promise<string>;
      trajectoryStats(): Promise<{ missions: number; lines: number }>;
      alarmDemo?(): Promise<void>;
      schedulerDemo?(): Promise<void>;
    };
  }).flux;

  const assetCommits = events.filter((e) => e.topic === "asset.committed").length;

  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const m = JSON.parse(await flux.mcpCall("query_asset", { query: "mission", limit: 60 })) as MissionAsset[];
        setMissions((Array.isArray(m) ? m : []).filter((a) => a.type === "mission").sort((a, b) => a.ts - b.ts));
      } catch { /* store empty */ }
      try {
        const b = JSON.parse(await flux.mcpCall("query_asset", { query: "bench-result", limit: 60 })) as BenchAsset[];
        setBench((Array.isArray(b) ? b : []).filter((a) => a.type === "bench-result"));
      } catch { /* none yet */ }
      try {
        const ev = JSON.parse(await flux.mcpCall("query_asset", { query: "evidence-bundle", limit: 20 })) as Array<{ id: string; ts: number; type: string }>;
        setEvidence((Array.isArray(ev) ? ev : []).filter((a) => a.type === "evidence-bundle"));
      } catch { /* none yet */ }
      try { setUsage(JSON.parse(await flux.mcpCall("usage_stats", { days: 7 })) as UsageStats); } catch { /* metering off */ }
      try { setTraj(await flux.trajectoryStats()); } catch { /* dir absent */ }
    };
    void load();
  }, [assetCommits]); // refresh whenever anything lands in the store

  // North star: cumulative distinct devices brought to DevReady (PASS missions).
  const devready = useMemo(() => {
    const fams = new Set<string>();
    for (const m of missions) {
      if (m.characterization?.verdict === "PASS") fams.add(m.id.split("-")[0] === "mission" ? (m as unknown as { components?: string[] }).components?.[0] ?? m.id : m.id);
    }
    return fams.size;
  }, [missions]);

  const ttd = missions.filter((m) => m.characterization?.time_to_devready_ms)
    .map((m) => (m.characterization.time_to_devready_ms ?? 0) / 1000);
  const hits = missions.map((m) => m.characterization?.asset_hits ?? 0);

  // Bench scoreboard: model × condition → best score.
  const benchMatrix = useMemo(() => {
    const map = new Map<string, Map<string, number>>();
    for (const b of bench) {
      const c = b.characterization ?? {};
      const row = map.get(c.model ?? "?") ?? new Map<string, number>();
      const prev = row.get(c.condition ?? "?") ?? -1;
      row.set(c.condition ?? "?", Math.max(prev, c.score ?? 0));
      map.set(c.model ?? "?", row);
    }
    return map;
  }, [bench]);

  const card: React.CSSProperties = { border: "1px solid var(--border)", borderRadius: 6, padding: 12, background: "var(--paper)" };

  return (
    <div style={{ padding: 16, overflow: "auto", height: "100%", display: "flex", flexDirection: "column", gap: 14 }}>
      {/* North star */}
      <div style={{ ...card, display: "flex", alignItems: "baseline", gap: 16 }}>
        <span style={{ fontSize: 44, fontWeight: 800, color: "#4caf50", lineHeight: 1 }}>{devready}</span>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700 }}>{t("dash.northStar")}</div>
          <div style={{ fontSize: 10.5, color: "var(--grey-3)" }}>{t("dash.northStarSub")}</div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right", fontSize: 11, color: "var(--grey-3)" }}>
          <div>{t("dash.corpus")}: <b style={{ color: "var(--ink)" }}>{traj.lines}</b> {t("dash.corpusLines")} · {traj.missions} missions</div>
          {usage && (
            <div style={{ marginTop: 3 }}>
              {t("dash.tokens")}: {usage.total_in + usage.total_out} · ${usage.cost_usd}
              <span style={{ color: "#4caf50" }}> · {t("dash.saved")} {usage.saved_pct}%</span>
            </div>
          )}
        </div>
        <button data-guide="alarm-demo" className="chat-send" style={{ marginLeft: 12 }} title={t("dash.alarmTip")}
          onClick={() => void flux.schedulerDemo?.()}>⚡ {t("dash.alarmBtn")}</button>
      </div>

      {/* Live kernel scheduler — the RTOS heart that makes this "not another VSCode". */}
      <SchedulerViz state={schedState ?? null}
        onDemo={() => void flux.schedulerDemo?.()}
        demoLabel={t("dash.schedDemo")} />

      {/* Curves appear once there is data — empty charts sell nothing. */}
      {missions.length === 0 ? (
        <div style={{ ...card, color: "var(--grey-3)", fontSize: 12, lineHeight: 1.7 }}>{t("dash.firstHint")}</div>
      ) : (
        <div style={{ display: "flex", gap: 14, flexWrap: "wrap" }}>
          <div style={card}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--grey-3)", marginBottom: 4 }}>{t("dash.curveTtd")}</div>
            <Curve values={ttd} color="#2196f3" unit="s" />
          </div>
          <div style={card}>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--grey-3)", marginBottom: 4 }}>{t("dash.curveReuse")}</div>
            <Curve values={hits} color="#4caf50" unit="" />
          </div>
        </div>
      )}

      {/* Bench scoreboard — hidden until a bench run exists */}
      {benchMatrix.size > 0 && (
      <div style={card}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--grey-3)", marginBottom: 6 }}>{t("dash.bench")}</div>
        {benchMatrix.size === 0 ? (
          <div style={{ color: "var(--grey-3)", fontSize: 11 }}>{t("dash.benchEmpty")}</div>
        ) : (
          <table style={{ fontSize: 11, borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "2px 12px 2px 0", color: "var(--grey-3)" }}>model</th>
                <th style={{ padding: "2px 12px", color: "var(--grey-3)" }}>bare</th>
                <th style={{ padding: "2px 12px", color: "var(--grey-3)" }}>with_assets</th>
                <th style={{ padding: "2px 12px", color: "var(--grey-3)" }}>Δ</th>
              </tr>
            </thead>
            <tbody>
              {[...benchMatrix.entries()].map(([model, row]) => {
                const bare = row.get("bare") ?? 0, wa = row.get("with_assets") ?? 0;
                return (
                  <tr key={model}>
                    <td style={{ padding: "2px 12px 2px 0", fontFamily: "var(--mono, monospace)" }}>{model}</td>
                    <td style={{ padding: "2px 12px", textAlign: "center" }}>{Math.round(bare * 100)}%</td>
                    <td style={{ padding: "2px 12px", textAlign: "center" }}>{Math.round(wa * 100)}%</td>
                    <td style={{ padding: "2px 12px", textAlign: "center", color: wa > bare ? "#4caf50" : "#888", fontWeight: 700 }}>
                      {wa - bare >= 0 ? "+" : ""}{Math.round((wa - bare) * 100)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      )}

      {/* Evidence bundles — hidden until the first verified run exists */}
      {evidence.length > 0 && (
      <div style={card}>
        <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--grey-3)", marginBottom: 6 }}>{t("dash.evidence")}</div>
        {evidence.slice(-8).reverse().map((e) => (
          <div key={e.id} style={{ fontSize: 10.5, fontFamily: "var(--mono, monospace)", color: "#558b2f", padding: "1px 0" }}>
            🔒 {e.id} · {new Date(e.ts * 1000).toLocaleString()}
          </div>
        ))}
      </div>
      )}
    </div>
  );
}
