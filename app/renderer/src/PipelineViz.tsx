// PipelineViz — the dev-flow made visible (right panel, cc-wf-studio style).
// Merges the old "Kernel Monitor" + "Insight Loop" into one live node graph:
// nodes light up as bus events flow through the corresponding stage, edges
// pulse on recent activity. Pure SVG, theme-aware, no dependencies.
import React, { useMemo } from "react";
import { useLang } from "./i18n";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

interface Node {
  id: string;
  labelKey: string;
  x: number; y: number;
  topics: string[]; // activity source
}

const NODES: Node[] = [
  { id: "device", labelKey: "pipe.device", x: 10, y: 64, topics: ["device.attached", "openocd.event"] },
  { id: "identify", labelKey: "pipe.identify", x: 78, y: 64, topics: ["mission.milestone"] },
  { id: "assets", labelKey: "pipe.assets", x: 146, y: 64, topics: ["asset.committed"] },
  { id: "plan", labelKey: "pipe.plan", x: 214, y: 64, topics: ["hil.plan", "mcp.tool.result"] },
  { id: "verify", labelKey: "pipe.verify", x: 282, y: 64, topics: ["hil.step", "sim.state"] },
  { id: "report", labelKey: "pipe.report", x: 350, y: 64, topics: ["hil.report"] },
  { id: "build", labelKey: "pipe.build", x: 146, y: 12, topics: ["build.progress", "build.diagnostic"] },
  { id: "train", labelKey: "pipe.train", x: 214, y: 116, topics: ["training.metrics", "training.progress", "training.started"] },
  { id: "triage", labelKey: "pipe.triage", x: 282, y: 12, topics: ["triage.result"] },
];

const EDGES: Array<[string, string]> = [
  ["device", "identify"], ["identify", "assets"], ["assets", "plan"],
  ["plan", "verify"], ["verify", "report"],
  ["build", "assets"], ["assets", "train"], ["verify", "triage"], ["triage", "assets"],
];

const NW = 58, NH = 24;

export function PipelineViz({ events }: { events: FluxEvent[] }): React.ReactElement {
  const { t } = useLang();

  // Activity = event count per node; "hot" = appears in the newest 12 events.
  const { counts, hot } = useMemo(() => {
    const counts = new Map<string, number>();
    const hot = new Set<string>();
    const recent = new Set(events.slice(-12).map((e) => e.topic));
    for (const n of NODES) {
      let c = 0;
      for (const tp of n.topics) c += events.filter((e) => e.topic === tp).length;
      counts.set(n.id, c);
      if (n.topics.some((tp) => recent.has(tp))) hot.add(n.id);
    }
    return { counts, hot };
  }, [events]);

  const center = (n: Node): { cx: number; cy: number } => ({ cx: n.x + NW / 2, cy: n.y + NH / 2 });
  const byId = new Map(NODES.map((n) => [n.id, n]));

  return (
    <svg viewBox="0 0 420 152" style={{ width: "100%", display: "block" }}>
      {EDGES.map(([a, b], i) => {
        const na = byId.get(a)!, nb = byId.get(b)!;
        const { cx: x1, cy: y1 } = center(na);
        const { cx: x2, cy: y2 } = center(nb);
        const active = hot.has(a) && (counts.get(b) ?? 0) >= 0 && hot.has(b);
        return (
          <line key={i} x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={active ? "var(--accent)" : "var(--grey-2)"}
            strokeWidth={active ? 1.6 : 1} strokeDasharray={active ? "4 3" : undefined}>
            {active && <animate attributeName="stroke-dashoffset" from="14" to="0" dur="0.8s" repeatCount="indefinite" />}
          </line>
        );
      })}
      {NODES.map((n) => {
        const c = counts.get(n.id) ?? 0;
        const isHot = hot.has(n.id);
        const active = c > 0;
        return (
          <g key={n.id}>
            <rect x={n.x} y={n.y} width={NW} height={NH} rx={5}
              fill={isHot ? "rgba(0,47,167,.10)" : active ? "var(--grey-1)" : "var(--paper)"}
              stroke={isHot ? "var(--accent)" : active ? "var(--grey-3)" : "var(--grey-2)"}
              strokeWidth={isHot ? 1.5 : 1} />
            <text x={n.x + NW / 2} y={n.y + 11} textAnchor="middle" fontSize={7.5}
              fill={active ? "var(--ink)" : "var(--grey-3)"} fontWeight={isHot ? 700 : 500}
              fontFamily="var(--mono)">
              {t(n.labelKey)}
            </text>
            <text x={n.x + NW / 2} y={n.y + 20} textAnchor="middle" fontSize={7}
              fill={isHot ? "var(--accent)" : "var(--grey-3)"} fontFamily="var(--mono)">
              {c > 0 ? `×${c}` : "·"}
            </text>
            {isHot && (
              <circle cx={n.x + NW - 4} cy={n.y + 4} r={2.5} fill="var(--accent)">
                <animate attributeName="opacity" values="1;0.2;1" dur="1s" repeatCount="indefinite" />
              </circle>
            )}
          </g>
        );
      })}
    </svg>
  );
}
