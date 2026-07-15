// AssetDetail — per-asset actions modal (right panel, issue: cross-compile
// lives ON the asset, not as a floating section).
// Tabs: PIN/外设分布 (visualize the register map / dts nodes), 交叉编译
// (build against this board + toolchain list), USD/仿真 (sim & robot facts),
// 属性 (full envelope + health).
import React, { useEffect, useState } from "react";
import { useLang } from "./i18n";

interface AssetSummary { id: string; type: string; components?: string[] }

type Tab = "pins" | "build" | "usd" | "props";

export function AssetDetail({ asset, projectPath, onClose }: {
  asset: AssetSummary;
  projectPath: string;
  onClose: () => void;
}): React.ReactElement {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>("pins");
  const [full, setFull] = useState<Record<string, unknown> | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildOut, setBuildOut] = useState("");
  const flux = (window as unknown as {
    flux: {
      mcpCall(tool: string, args: Record<string, unknown>): Promise<string>;
      build(dir: string, opts?: Record<string, unknown>): Promise<{ ok: boolean; elf?: string; error?: string }>;
    };
  }).flux;

  useEffect(() => {
    void flux.mcpCall("query_asset", { asset_id: asset.id })
      .then((text) => setFull(JSON.parse(text) as Record<string, unknown>))
      .catch(() => setFull(null));
  }, [asset.id]);

  const char = (full?.["characterization"] ?? {}) as Record<string, unknown>;
  const peripherals = (char["peripherals"] ?? []) as Array<{ name?: string; base_address?: unknown; registers?: unknown[] }>;
  const nodes = (char["nodes"] ?? []) as Array<{ label?: string; path?: string; reg?: { addr?: unknown } }>;

  const doBuild = async (): Promise<void> => {
    setBuilding(true); setBuildOut("");
    try {
      const r = await flux.build(projectPath, {});
      setBuildOut(r.ok ? `✓ ${r.elf}` : `✗ ${(r.error ?? "").slice(0, 300)}`);
    } catch (e) { setBuildOut(`✗ ${(e as Error).message.slice(0, 200)}`); }
    finally { setBuilding(false); }
  };

  const hexy = (v: unknown): string => {
    const n = typeof v === "number" ? v : parseInt(String(v ?? ""), 10);
    return Number.isFinite(n) ? `0x${n.toString(16).toUpperCase().padStart(8, "0")}` : String(v ?? "—");
  };

  return (
    <div className="asset-modal" onClick={onClose}>
      <div className="asset-card" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", alignItems: "center", padding: "10px 14px", gap: 8 }}>
          <b style={{ fontSize: 13 }}>{asset.id}</b>
          <span className="mod-chip">{asset.type}</span>
          <button className="ft-btn" style={{ marginLeft: "auto" }} onClick={onClose}>✕</button>
        </div>
        <div className="asset-tabs">
          {([["pins", t("ad.pins")], ["build", t("ad.build")], ["usd", t("ad.usd")], ["props", t("ad.props")]] as Array<[Tab, string]>).map(([k, label]) => (
            <div key={k} data-guide={k === "build" ? "ad-tab-build" : undefined} className={`asset-tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</div>
          ))}
        </div>
        <div className="asset-body">
          {tab === "pins" && (
            peripherals.length > 0 ? (
              <div className="pin-grid">
                {peripherals.map((p, i) => (
                  <div key={i} className="pin-cell">
                    <b>{p.name}</b>
                    <div>{hexy(p.base_address)}</div>
                    <div style={{ color: "var(--grey-3)" }}>{(p.registers as unknown[] | undefined)?.length ?? 0} regs</div>
                  </div>
                ))}
              </div>
            ) : nodes.length > 0 ? (
              <div className="pin-grid">
                {nodes.slice(0, 60).map((n, i) => (
                  <div key={i} className="pin-cell">
                    <b>{n.label || n.path?.split("/").pop()}</b>
                    <div>{hexy(n.reg?.addr)}</div>
                  </div>
                ))}
              </div>
            ) : <div style={{ color: "var(--grey-3)", fontSize: 11 }}>{t("ad.noPins")}</div>
          )}
          {tab === "build" && (
            <div style={{ fontSize: 11 }}>
              <div style={{ color: "var(--grey-3)", marginBottom: 8 }}>{t("ad.buildHint")} <code>{projectPath}</code></div>
              <button data-guide="ad-build" className="chat-send" disabled={building} onClick={() => void doBuild()}>
                {building ? t("rp.building") : t("rp.buildBtn")}
              </button>
              {buildOut && <div style={{ marginTop: 8, fontFamily: "var(--mono)", fontSize: 10.5, wordBreak: "break-all" }}>{buildOut}</div>}
              <div style={{ marginTop: 14, color: "var(--grey-3)", fontWeight: 600 }}>{t("ad.toolchain")}</div>
              {["riscv32 GCC (xpack)", "HPM_SDK", "HPM OpenOCD", "Zephyr west + gnuarmemb"].map((x) => (
                <div key={x} className="mod-row"><span className="ws-dot" style={{ background: "#4caf50" }} />{x}</div>
              ))}
            </div>
          )}
          {tab === "usd" && (
            <div style={{ fontSize: 11 }}>
              {asset.type === "urdf" ? (
                <>
                  <div>links: <b>{String(char["links"] ?? "—")}</b> · joints: <b>{String(char["joints"] ?? "—")}</b></div>
                  <div style={{ color: "var(--grey-3)", marginTop: 6 }}>{t("ad.usdUrdf")}</div>
                </>
              ) : asset.type === "sim-platform" ? (
                <div>{t("ad.usdSim")}: <code>{String(char["repl"] ?? "")}</code></div>
              ) : (
                <div style={{ color: "var(--grey-3)" }}>{t("ad.usdNa")}</div>
              )}
            </div>
          )}
          {tab === "props" && (
            <pre className="code-view" style={{ maxHeight: 380, fontSize: 10.5 }}>
              {JSON.stringify(full ?? { loading: true }, null, 2).slice(0, 12000)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
