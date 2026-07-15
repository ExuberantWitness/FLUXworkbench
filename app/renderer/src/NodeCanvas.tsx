// NodeCanvas — ComfyUI-style editor for UnitPort canvas JSON.
// Schema (from custom_mods/canvas/*.json): nodes[{id, schema_id, params:{k:{name,value,param_type}},
// disabled}], edges[{source_node, target_node, source_port, target_port}].
// Templates carry no positions → topological auto-layout (layer = longest
// path from a source). Nodes are draggable; clicking one opens the inspector
// where params are edited in place (onChange receives the mutated canvas).
import React, { useMemo, useRef, useState } from "react";

export interface CanvasParam { name?: string; value?: unknown; param_type?: string }
export interface CanvasNode { id: string; schema_id?: string; params?: Record<string, CanvasParam>; disabled?: boolean }
export interface CanvasEdge { id?: string; source_node: string; target_node: string; source_port?: string; target_port?: string }
export interface UpCanvas { backend?: string; robot_id?: string; nodes: CanvasNode[]; edges: CanvasEdge[]; [k: string]: unknown }

const NW = 168, NH = 78, GX = 60, GY = 26;

const HUES: Record<string, string> = {
  robot: "#7c3aed", rewards: "#0a7d33", il_observation: "#0e7490", base_asset: "#b45309",
  play_ground_setting: "#002FA7", export: "#9d174d", terminations: "#b91c1c",
  domain_rand: "#a16207", training_motion: "#4338ca", algorithm: "#0f766e",
};
const hue = (schema: string): string => HUES[schema] ?? "#5B7BFF";

/** Longest-path layering: sources at layer 0, every edge goes rightward. */
function layout(nodes: CanvasNode[], edges: CanvasEdge[]): Map<string, { x: number; y: number }> {
  const layer = new Map<string, number>();
  const ids = new Set(nodes.map((n) => n.id));
  for (const n of nodes) layer.set(n.id, 0);
  for (let pass = 0; pass < nodes.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (!ids.has(e.source_node) || !ids.has(e.target_node)) continue;
      const want = (layer.get(e.source_node) ?? 0) + 1;
      if (want > (layer.get(e.target_node) ?? 0) && want < 12) {
        layer.set(e.target_node, want);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const byLayer = new Map<number, string[]>();
  for (const n of nodes) {
    const l = layer.get(n.id) ?? 0;
    byLayer.set(l, [...(byLayer.get(l) ?? []), n.id]);
  }
  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, list] of byLayer) {
    list.forEach((id, i) => pos.set(id, { x: 16 + l * (NW + GX), y: 16 + i * (NH + GY) }));
  }
  return pos;
}

const short = (v: unknown): string => {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return Array.isArray(v) ? `[${v.length}]` : "{…}";
  return String(v).slice(0, 22);
};

export function NodeCanvas({ canvas, onChange }: {
  canvas: UpCanvas;
  onChange: (c: UpCanvas) => void;
}): React.ReactElement {
  const [positions, setPositions] = useState<Map<string, { x: number; y: number }> | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const drag = useRef<{ id: string; dx: number; dy: number } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const pos = useMemo(() => positions ?? layout(canvas.nodes ?? [], canvas.edges ?? []),
    [canvas, positions]);

  const extent = useMemo(() => {
    let w = 400, h = 200;
    for (const p of pos.values()) { w = Math.max(w, p.x + NW + 40); h = Math.max(h, p.y + NH + 40); }
    return { w, h };
  }, [pos]);

  const onMouseDown = (e: React.MouseEvent, id: string): void => {
    const p = pos.get(id);
    if (!p) return;
    drag.current = { id, dx: e.clientX - p.x, dy: e.clientY - p.y };
  };
  const onMouseMove = (e: React.MouseEvent): void => {
    if (!drag.current) return;
    const { id, dx, dy } = drag.current;
    const next = new Map(pos);
    next.set(id, { x: Math.max(0, e.clientX - dx), y: Math.max(0, e.clientY - dy) });
    setPositions(next);
  };

  const setParam = (nodeId: string, key: string, raw: string): void => {
    const next: UpCanvas = { ...canvas, nodes: canvas.nodes.map((n) => {
      if (n.id !== nodeId) return n;
      const prev = n.params?.[key] ?? {};
      let value: unknown = raw;
      if (typeof prev.value === "number") value = Number(raw);
      else if (typeof prev.value === "boolean") value = raw === "true";
      else if (typeof prev.value === "object" && prev.value !== null) {
        try { value = JSON.parse(raw); } catch { return n; }
      }
      return { ...n, params: { ...n.params, [key]: { ...prev, value } } };
    }) };
    onChange(next);
  };

  const sel = canvas.nodes?.find((n) => n.id === selected);

  return (
    <div style={{ display: "flex", height: "100%", minHeight: 0, gap: 0 }}>
      {/* graph */}
      <div ref={wrapRef} style={{ flex: 1, overflow: "auto", position: "relative", background: "var(--grey-1)", borderRadius: 4, border: "1px solid var(--border)" }}
        onMouseMove={onMouseMove} onMouseUp={() => { drag.current = null; }} onMouseLeave={() => { drag.current = null; }}>
        <div style={{ position: "relative", width: extent.w, height: extent.h,
          backgroundImage: "radial-gradient(var(--grey-2) 1px, transparent 1px)", backgroundSize: "18px 18px" }}>
          <svg width={extent.w} height={extent.h} style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
            {(canvas.edges ?? []).map((e, i) => {
              const a = pos.get(e.source_node), b = pos.get(e.target_node);
              if (!a || !b) return null;
              const x1 = a.x + NW, y1 = a.y + NH / 2, x2 = b.x, y2 = b.y + NH / 2;
              const mx = (x1 + x2) / 2;
              const hot = selected === e.source_node || selected === e.target_node;
              return (
                <path key={e.id ?? i} d={`M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`}
                  fill="none" stroke={hot ? "var(--accent)" : "var(--grey-2)"} strokeWidth={hot ? 2 : 1.3}>
                  <title>{`${e.source_port ?? ""} → ${e.target_port ?? ""}`}</title>
                </path>
              );
            })}
          </svg>
          {(canvas.nodes ?? []).map((n) => {
            const p = pos.get(n.id) ?? { x: 0, y: 0 };
            const c = hue(n.schema_id ?? "");
            const entries = Object.entries(n.params ?? {}).slice(0, 3);
            return (
              <div key={n.id}
                onMouseDown={(e) => onMouseDown(e, n.id)}
                onClick={() => setSelected(n.id === selected ? null : n.id)}
                style={{
                  position: "absolute", left: p.x, top: p.y, width: NW, height: NH,
                  background: "var(--paper)", border: `1.5px solid ${selected === n.id ? "var(--accent)" : c}`,
                  borderRadius: 7, cursor: "grab", overflow: "hidden", userSelect: "none",
                  boxShadow: selected === n.id ? "0 4px 14px rgba(0,47,167,.22)" : "0 1px 4px rgba(0,0,0,.07)",
                  opacity: n.disabled ? 0.45 : 1,
                }}>
                <div style={{ background: c, color: "#fff", fontSize: 9.5, fontFamily: "var(--mono)", fontWeight: 700, padding: "3px 8px", display: "flex" }}>
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{n.schema_id}</span>
                  <span style={{ marginLeft: "auto", opacity: 0.7 }}>#{n.id}</span>
                </div>
                <div style={{ padding: "3px 8px", fontSize: 9, fontFamily: "var(--mono)", lineHeight: 1.6, color: "var(--grey-3)" }}>
                  {entries.map(([k, v]) => (
                    <div key={k} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      <span style={{ color: "var(--ink)" }}>{k}</span>: {short(v.value)}
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* inspector */}
      {sel && (
        <div style={{ width: 240, borderLeft: "1px solid var(--border)", overflow: "auto", padding: "8px 10px", flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, marginBottom: 6, display: "flex", alignItems: "center" }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: hue(sel.schema_id ?? ""), marginRight: 6 }} />
            {sel.schema_id} <span style={{ color: "var(--grey-3)", marginLeft: 4 }}>#{sel.id}</span>
            <button className="ft-btn" style={{ marginLeft: "auto" }} onClick={() => setSelected(null)}>✕</button>
          </div>
          {Object.entries(sel.params ?? {}).map(([k, v]) => {
            const isObj = typeof v.value === "object" && v.value !== null;
            return (
              <div key={k} style={{ marginBottom: 6 }}>
                <div style={{ fontSize: 9.5, fontFamily: "var(--mono)", color: "var(--grey-3)" }}>{k} <span style={{ opacity: 0.6 }}>({v.param_type ?? typeof v.value})</span></div>
                {isObj ? (
                  <textarea className="flux-textarea" style={{ width: "100%", height: 54, fontSize: 9.5 }}
                    defaultValue={JSON.stringify(v.value)}
                    onBlur={(e) => setParam(sel.id, k, e.target.value)} />
                ) : typeof v.value === "boolean" ? (
                  <select className="flux-select" style={{ width: "100%" }} value={String(v.value)}
                    onChange={(e) => setParam(sel.id, k, e.target.value)}>
                    <option>true</option><option>false</option>
                  </select>
                ) : (
                  <input className="flux-input mono" style={{ width: "100%" }} defaultValue={String(v.value ?? "")}
                    onBlur={(e) => setParam(sel.id, k, e.target.value)} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
