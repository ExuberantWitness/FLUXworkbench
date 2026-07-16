// AssetsPanel — the 资产 center tab: everything that creates DevReady assets.
// Sub-tabs: 调通 (device bring-up, absorbed from the old Mission tab) and
// 装配 (FluxWeave URDF assembly). Both flows end in the same asset store.
import React from "react";
import { MissionPanel } from "./MissionPanel";
import { FluxWeavePanel } from "./FluxWeavePanel";
import { PcbImportPanel } from "./PcbImportPanel";
import { useLang } from "./i18n";

interface FluxEvent { source?: string; kind?: string; topic: string; data: Record<string, unknown>; trace_id: string }

export function AssetsPanel({ events, sub, setSub }: {
  events: FluxEvent[];
  sub: "bringup" | "assembly" | "pcb";
  setSub: (s: "bringup" | "assembly" | "pcb") => void;
}): React.ReactElement {
  const { t } = useLang();
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
        {([["bringup", t("assets.bringup")], ["pcb", t("assets.pcb")], ["assembly", t("assets.assembly")]] as Array<["bringup" | "assembly" | "pcb", string]>).map(([k, label]) => (
          <div key={k} data-guide={k === "bringup" ? "sub-bringup" : k === "pcb" ? "sub-pcb" : "sub-assembly"}
            onClick={() => setSub(k)}
            style={{
              padding: "6px 16px", fontSize: 11, cursor: "pointer", fontFamily: "var(--mono)",
              color: sub === k ? "var(--ink)" : "var(--grey-3)",
              borderBottom: sub === k ? "2px solid var(--accent)" : "2px solid transparent",
              fontWeight: sub === k ? 600 : 400,
            }}>
            {label}
          </div>
        ))}
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
        {sub === "bringup" ? <MissionPanel events={events as never} /> : sub === "pcb" ? <PcbImportPanel /> : <FluxWeavePanel />}
      </div>
    </div>
  );
}
