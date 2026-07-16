// PcbImportPanel — 资产 sub-tab: turn a board's DESIGN files into a DevReady
// asset. For a custom board with no vendor part: point at a project dir with
// .ioc (CubeMX pin mux) + .NET (Altium/Protel netlist); the studio extracts the
// MCU, pins, peripherals, board devices, and the MCU-pin ↔ device wiring.
import React, { useState } from "react";
import { useLang } from "./i18n";
import { PinoutGraph } from "./PinoutGraph";

interface DeviceMapRow { gpio: string; function: string; signal: string; net: string; connects_to: string[] }
interface IngestResult {
  error?: string; board?: string; mcu?: string; arch?: string; pin_count?: number;
  peripherals?: string[]; board_devices?: string[]; asset_id?: string;
  sources?: { ioc: boolean; netlist: boolean };
  device_map?: DeviceMapRow[];
}

export function PcbImportPanel(): React.ReactElement {
  const { t } = useLang();
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<IngestResult | null>(null);
  const flux = (window as unknown as {
    flux: {
      openFolder(): Promise<string | null>;
      mcpCall(tool: string, args: Record<string, unknown>): Promise<string>;
      fetchRepo(url: string): Promise<{ ok: boolean; path?: string; error?: string }>;
    };
  }).flux;

  const pick = async (): Promise<void> => {
    const p = await flux.openFolder();
    if (p) setDir(p);
  };
  const ingest = async (): Promise<void> => {
    if (!dir) return;
    setBusy(true); setRes(null);
    // a GitHub/git URL is cloned locally first, then ingested.
    let projectDir = dir;
    if (/^https?:\/\/|git@/.test(dir.trim())) {
      const r = await flux.fetchRepo(dir.trim());
      if (!r.ok || !r.path) { setRes({ error: `clone failed: ${r.error ?? "?"}` }); setBusy(false); return; }
      projectDir = r.path;
    }
    try {
      // device_map lives in the committed asset; the tool returns the summary,
      // so re-query the asset for the full wiring table.
      const out = JSON.parse(await flux.mcpCall("ingest_design", { project_dir: projectDir })) as IngestResult;
      if (!out.error && out.asset_id) {
        try {
          const full = JSON.parse(await flux.mcpCall("query_asset", { asset_id: out.asset_id })) as {
            characterization?: { device_map?: DeviceMapRow[] };
          };
          out.device_map = full.characterization?.device_map ?? [];
        } catch { /* asset re-read failed — summary still shown */ }
      }
      setRes(out);
    } catch (e) { setRes({ error: (e as Error).message }); }
    finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, padding: 16, height: "100%", overflow: "auto" }}>
      <div style={{ fontSize: 12, color: "var(--grey-3)", lineHeight: 1.6 }}>{t("pcb.head")}</div>
      <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <input data-guide="pcb-input" className="flux-input mono" style={{ flex: 1 }} value={dir} placeholder={t("pcb.dirPh")}
          onChange={(e) => setDir(e.target.value)} />
        <button className="ft-btn" onClick={() => void pick()}>📂</button>
        <button data-guide="pcb-ingest" className="chat-send" disabled={busy || !dir} onClick={() => void ingest()}>
          {busy ? "…" : t("pcb.ingest")}
        </button>
      </div>

      {res?.error && <div style={{ color: "#b91c1c", fontSize: 11.5 }}>✗ {res.error}</div>}

      {res && !res.error && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div className="rp-card">
            <div style={{ fontSize: 14, fontWeight: 700, color: "#2e7d32" }}>✓ {res.mcu}
              <span style={{ fontSize: 11, fontWeight: 400, color: "var(--grey-3)", marginLeft: 8 }}>
                {res.arch} · {res.pin_count} {t("pcb.pins")} · {res.asset_id}
              </span>
            </div>
            <div style={{ fontSize: 10.5, color: "var(--grey-3)", marginTop: 4 }}>
              {t("pcb.sources")}: {res.sources?.ioc ? ".ioc" : ""}{res.sources?.ioc && res.sources?.netlist ? " + " : ""}{res.sources?.netlist ? ".NET" : ""}
              {" · "}{t("pcb.peripherals")}: {(res.peripherals ?? []).join(", ")}
            </div>
            <div style={{ fontSize: 10.5, color: "var(--grey-3)", marginTop: 2 }}>
              {t("pcb.devices")}: {(res.board_devices ?? []).join(" · ")}
            </div>
          </div>

          {res.device_map && res.device_map.length > 0 && (
            <div className="rp-card">
              <PinoutGraph deviceMap={res.device_map} mcu={res.mcu ?? ""} />
            </div>
          )}
          {res.device_map && res.device_map.length > 0 && (
            <div className="rp-card">
              <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--grey-3)", marginBottom: 6 }}>{t("pcb.wiring")}</div>
              <table style={{ fontSize: 11, borderCollapse: "collapse", width: "100%" }}>
                <thead>
                  <tr style={{ color: "var(--grey-3)", textAlign: "left" }}>
                    <th style={{ padding: "2px 10px 2px 0" }}>GPIO</th>
                    <th style={{ padding: "2px 10px" }}>{t("pcb.function")}</th>
                    <th style={{ padding: "2px 10px" }}>{t("pcb.connectsTo")}</th>
                  </tr>
                </thead>
                <tbody>
                  {res.device_map.map((r, i) => (
                    <tr key={i} style={{ borderTop: "1px solid var(--grey-1)" }}>
                      <td style={{ padding: "3px 10px 3px 0", fontFamily: "var(--mono)", color: "var(--accent)" }}>{r.gpio}</td>
                      <td style={{ padding: "3px 10px" }}><span className="mod-chip">{r.function}</span></td>
                      <td style={{ padding: "3px 10px", fontFamily: "var(--mono)" }}>{r.connects_to.join(", ")}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div style={{ fontSize: 10, color: "var(--grey-3)" }}>{t("pcb.next")}</div>
        </div>
      )}
    </div>
  );
}
