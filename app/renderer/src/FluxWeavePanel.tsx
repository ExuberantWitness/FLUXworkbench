// FluxWeave native panel — URDF assembly migrated into the studio.
// Parts + connectors are edited structurally (or as raw graph JSON), URDF is
// generated through the fw_generate_urdf MCP tool and committed as an asset.
import React, { useState } from "react";
import { useLang } from "./i18n";

interface Part { id: string; link_name: string; stl_file?: string }
interface Connector {
  parent_id: string; child_id: string; joint_name: string; joint_type: string;
  parent_axis: number[]; child_axis: number[];
  parent_local_xyz: number[]; child_local_xyz: number[];
}

const inputStyle: React.CSSProperties = {
  background: "var(--paper)", color: "var(--ink)", border: "1px solid var(--grey-2)",
  borderRadius: 3, padding: "3px 6px", fontSize: 11, fontFamily: "var(--mono, monospace)", outline: "none",
};

export function FluxWeavePanel(): React.ReactElement {
  const { t } = useLang();
  const [robotName, setRobotName] = useState("my_robot");
  const [parts, setParts] = useState<Part[]>([{ id: "link1", link_name: "link1" }]);
  const [conns, setConns] = useState<Connector[]>([{
    parent_id: "__base__", child_id: "link1", joint_name: "joint1", joint_type: "revolute",
    parent_axis: [0, 0, 1], child_axis: [0, 0, 1],
    parent_local_xyz: [0, 0, 0], child_local_xyz: [0, 0, 0],
  }]);
  const [urdf, setUrdf] = useState("");
  const [assetId, setAssetId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const flux = (window as unknown as { flux: { mcpCall(tool: string, args: Record<string, unknown>): Promise<string> } }).flux;

  const vec = (v: number[]): string => v.join(",");
  const parseVec = (s: string): number[] => s.split(",").map((x) => Number(x.trim()) || 0);

  const generate = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const graph = { robot_name: robotName, base_link: "base_link", parts, connectors: conns };
      const text = await flux.mcpCall("fw_generate_urdf", { graph });
      const d = JSON.parse(text) as { asset_id?: string; urdf?: string; error?: string };
      if (d.error) throw new Error(d.error);
      setUrdf(d.urdf ?? ""); setAssetId(d.asset_id ?? "");
    } catch (e) { setError((e as Error).message.slice(0, 200)); }
    finally { setBusy(false); }
  };

  const readStl = async (i: number): Promise<void> => {
    const path = parts[i]?.stl_file;
    if (!path) return;
    try {
      const meta = JSON.parse(await flux.mcpCall("fw_read_metadata", { stl_path: path })) as { link_name?: string };
      if (meta.link_name) {
        setParts(parts.map((p, j) => (j === i ? { ...p, link_name: meta.link_name! } : p)));
      }
    } catch { /* no metadata — keep manual name */ }
  };

  return (
    <div style={{ display: "flex", gap: 10, padding: 12, height: "100%", overflow: "hidden", fontSize: 11 }}>
      <div style={{ flex: 1, overflow: "auto", display: "flex", flexDirection: "column", gap: 8 }}>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <span style={{ color: "var(--grey-3)" }}>{t("fw.robot")}</span>
          <input style={{ ...inputStyle, flex: 1 }} value={robotName} onChange={(e) => setRobotName(e.target.value)} />
          <button className="chat-send" disabled={busy} onClick={() => void generate()}>
            {busy ? "…" : t("fw.generate")}
          </button>
        </div>

        <div style={{ color: "var(--grey-3)", fontWeight: 600 }}>{t("fw.parts")} ({parts.length})
          <button className="chat-send" style={{ marginLeft: 8, padding: "1px 8px" }}
            onClick={() => setParts([...parts, { id: `link${parts.length + 1}`, link_name: `link${parts.length + 1}` }])}>+</button>
        </div>
        {parts.map((p, i) => (
          <div key={i} style={{ display: "flex", gap: 4, alignItems: "center" }}>
            <input style={{ ...inputStyle, width: 90 }} value={p.id} title="id"
              onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, id: e.target.value } : x))} />
            <input style={{ ...inputStyle, width: 110 }} value={p.link_name} title="link name"
              onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, link_name: e.target.value } : x))} />
            <input style={{ ...inputStyle, flex: 1 }} value={p.stl_file ?? ""} placeholder={t("fw.stlPh")}
              onChange={(e) => setParts(parts.map((x, j) => j === i ? { ...x, stl_file: e.target.value } : x))}
              onBlur={() => void readStl(i)} />
            <button className="chat-send" style={{ padding: "1px 6px" }} onClick={() => setParts(parts.filter((_, j) => j !== i))}>✕</button>
          </div>
        ))}

        <div style={{ color: "var(--grey-3)", fontWeight: 600 }}>{t("fw.joints")} ({conns.length})
          <button className="chat-send" style={{ marginLeft: 8, padding: "1px 8px" }}
            onClick={() => setConns([...conns, {
              parent_id: parts[0]?.id ?? "__base__", child_id: "", joint_name: `joint${conns.length + 1}`,
              joint_type: "revolute", parent_axis: [0, 0, 1], child_axis: [0, 0, 1],
              parent_local_xyz: [0, 0, 0], child_local_xyz: [0, 0, 0],
            }])}>+</button>
        </div>
        {conns.map((c, i) => {
          const upd = (patch: Partial<Connector>): void => setConns(conns.map((x, j) => j === i ? { ...x, ...patch } : x));
          return (
            <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 4, padding: 6, display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ display: "flex", gap: 4 }}>
                <input style={{ ...inputStyle, width: 100 }} value={c.joint_name} title="joint name" onChange={(e) => upd({ joint_name: e.target.value })} />
                <select style={inputStyle} value={c.joint_type} onChange={(e) => upd({ joint_type: e.target.value })}>
                  {["revolute", "continuous", "prismatic", "fixed"].map((t) => <option key={t}>{t}</option>)}
                </select>
                <select style={inputStyle} value={c.parent_id} title="parent" onChange={(e) => upd({ parent_id: e.target.value })}>
                  <option value="__base__">base_link</option>
                  {parts.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                </select>
                <span style={{ color: "var(--grey-3)" }}>→</span>
                <select style={inputStyle} value={c.child_id} title="child" onChange={(e) => upd({ child_id: e.target.value })}>
                  <option value="">(child)</option>
                  {parts.map((p) => <option key={p.id} value={p.id}>{p.id}</option>)}
                </select>
                <button className="chat-send" style={{ padding: "1px 6px", marginLeft: "auto" }} onClick={() => setConns(conns.filter((_, j) => j !== i))}>✕</button>
              </div>
              <div style={{ display: "flex", gap: 4, alignItems: "center", color: "var(--grey-3)" }}>
                {t("fw.axis")} <input style={{ ...inputStyle, width: 70 }} value={vec(c.parent_axis)} onChange={(e) => upd({ parent_axis: parseVec(e.target.value), child_axis: parseVec(e.target.value) })} />
                {t("fw.atParent")} <input style={{ ...inputStyle, width: 90 }} value={vec(c.parent_local_xyz)} title="parent attach point" onChange={(e) => upd({ parent_local_xyz: parseVec(e.target.value) })} />
                {t("fw.atChild")} <input style={{ ...inputStyle, width: 90 }} value={vec(c.child_local_xyz)} title="child attach point" onChange={(e) => upd({ child_local_xyz: parseVec(e.target.value) })} />
              </div>
            </div>
          );
        })}
        {error && <div style={{ color: "#f44336" }}>{error}</div>}
      </div>

      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 4, minWidth: 0 }}>
        <div style={{ color: "var(--grey-3)", fontWeight: 600 }}>
          {t("fw.urdf")} {assetId && <span style={{ color: "#4caf50" }}>{t("fw.committed")} {assetId}</span>}
        </div>
        <textarea readOnly value={urdf} placeholder={t("fw.urdfPh")}
          style={{ flex: 1, ...inputStyle, resize: "none", fontSize: 10.5 }} />
      </div>
    </div>
  );
}
