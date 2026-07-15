// AssetDetail — per-asset actions modal (right panel, issue: cross-compile
// lives ON the asset, not as a floating section).
// Tabs: PIN/外设分布 (visualize the register map / dts nodes), 交叉编译
// (build against this board + toolchain list), USD/仿真 (sim & robot facts),
// 属性 (full envelope + health).
import React, { useEffect, useState } from "react";
import { useLang } from "./i18n";
import { mdLite } from "./mdlite";

interface AssetSummary { id: string; type: string; components?: string[] }

type Tab = "pins" | "build" | "usd" | "wiki" | "journal" | "file" | "props";

export function AssetDetail({ asset, projectPath, onClose, onDeleted, revealInExplorer }: {
  asset: AssetSummary;
  projectPath: string;
  onClose: () => void;
  onDeleted?: (id: string) => void;
  revealInExplorer?: (path: string) => void;
}): React.ReactElement {
  const { t } = useLang();
  const [tab, setTab] = useState<Tab>("pins");
  const [full, setFull] = useState<Record<string, unknown> | null>(null);
  const [building, setBuilding] = useState(false);
  const [buildOut, setBuildOut] = useState("");
  const [note, setNote] = useState("");
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
  const identity = (full?.["identity"] ?? char["identity"] ?? {}) as { fingerprint?: string; serial?: string; board?: string };
  // .flux file path for devready assets (compose_devready lands it on disk).
  const board = identity.board ?? (asset.components ?? [])[0] ?? asset.id.replace(/^devready-/, "");
  const fluxPath = asset.type === "devready" ? `~/.flux/devready/${board}.flux` : "";

  const copy = (s: string, label: string): void => {
    void navigator.clipboard.writeText(s).then(() => setNote(`✓ ${label}`));
  };
  const doExport = async (): Promise<void> => {
    try {
      const out = JSON.parse(await flux.mcpCall("export_asset",
        { out_path: `~/.flux/exports/${asset.id}.bundle.json`, asset_id: asset.id }));
      setNote(`✓ ${t("ad.exported")}: ${out.path}`);
    } catch (e) { setNote(`✗ ${(e as Error).message.slice(0, 120)}`); }
  };
  const doDelete = async (): Promise<void> => {
    if (!window.confirm(`${t("ad.confirmDelete")} ${asset.id}?`)) return;
    try {
      await flux.mcpCall("delete_asset", { asset_id: asset.id });
      onDeleted?.(asset.id); onClose();
    } catch (e) { setNote(`✗ ${(e as Error).message.slice(0, 120)}`); }
  };
  const peripherals = (char["peripherals"] ?? []) as Array<{ name?: string; base_address?: unknown; registers?: unknown[] }>;
  const nodes = (char["nodes"] ?? []) as Array<{ label?: string; path?: string; reg?: { addr?: unknown } }>;
  // devready assets nest facts under characterization.body / .mind
  const drBody = (char["body"] ?? {}) as {
    pinmap?: { pins?: Array<{ pad?: string; function?: string; group?: string }> };
    memory_map?: Array<{ region?: string; origin?: string; length?: string }>;
  };
  const drPins = drBody.pinmap?.pins ?? [];
  const drMem = drBody.memory_map ?? [];
  const drMind = (char["mind"] ?? {}) as {
    rtos?: { default_runtime?: string; configured?: string | null; available?: Array<{ name?: string }> };
    build_howto?: { board_arg?: string; command?: string; sample_entry?: string };
    toolchain?: { env?: string; path_glob?: string };
  };
  const howto = drMind.build_howto;

  const reload = (): void => {
    void flux.mcpCall("query_asset", { asset_id: asset.id })
      .then((text) => setFull(JSON.parse(text) as Record<string, unknown>))
      .catch(() => void 0);
  };
  const [wikiBusy, setWikiBusy] = useState(false);
  const [lessonSym, setLessonSym] = useState("");
  const [lessonFix, setLessonFix] = useState("");
  const [openRef, setOpenRef] = useState(-1);
  const refreshWiki = async (): Promise<void> => {
    setWikiBusy(true); setNote("");
    try {
      await flux.mcpCall("compose_devready", { board, refresh_wiki: true });
      reload(); setNote(`✓ ${t("ad.wikiRefreshed")}`);
    } catch (e) { setNote(`✗ ${(e as Error).message.slice(0, 120)}`); }
    finally { setWikiBusy(false); }
  };
  const addLesson = async (): Promise<void> => {
    if (!lessonSym.trim()) return;
    try {
      await flux.mcpCall("add_board_lesson", { board, symptom: lessonSym, fix: lessonFix });
      setLessonSym(""); setLessonFix(""); reload(); setNote(`✓ ${t("ad.lessonAdded")}`);
    } catch (e) { setNote(`✗ ${(e as Error).message.slice(0, 120)}`); }
  };
  const genSkills = async (): Promise<void> => {
    try {
      const out = JSON.parse(await flux.mcpCall("gen_board_skill", { board }));
      setNote(out.error ? `✗ ${out.error}` : `✓ ${t("ad.skillsDone")}: ${out.skill_dir} (${(out.skills ?? []).length})`);
    } catch (e) { setNote(`✗ ${(e as Error).message.slice(0, 120)}`); }
  };

  const doBuild = async (): Promise<void> => {
    setBuilding(true); setBuildOut("");
    try {
      // devready builds ITS board's sample with ITS board arg; other assets
      // fall back to the workspace project.
      const dir = howto?.sample_entry ?? projectPath;
      const r = await flux.build(dir, howto?.board_arg ? { board: howto.board_arg } : {});
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
          {identity.fingerprint && <span className="mod-chip" title={t("ad.fingerprint")}>#{identity.fingerprint}</span>}
          {identity.serial && <span className="mod-chip grant" title="serial">SN {identity.serial}</span>}
          <span style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            {fluxPath && <button className="ft-btn" title={t("ad.skillsTip")} onClick={() => void genSkills()}>⚡</button>}
            <button className="ft-btn" title={t("ad.export")} onClick={() => void doExport()}>⬆</button>
            <button className="ft-btn" title={t("ad.delete")} onClick={() => void doDelete()}>🗑</button>
            <button className="ft-btn" onClick={onClose}>✕</button>
          </span>
        </div>
        <div className="asset-tabs">
          {([["pins", t("ad.pins")], ["build", t("ad.build")], ["usd", t("ad.usd")],
             ...(fluxPath ? [["wiki", t("ad.wiki")], ["journal", t("ad.journal")], ["file", t("ad.file")]] as Array<[Tab, string]> : []),
             ["props", t("ad.props")]] as Array<[Tab, string]>).map(([k, label]) => (
            <div key={k} data-guide={k === "build" ? "ad-tab-build" : undefined} className={`asset-tab ${tab === k ? "on" : ""}`} onClick={() => setTab(k)}>{label}</div>
          ))}
        </div>
        <div className="asset-body">
          {tab === "pins" && (
            drPins.length > 0 ? (
              <div style={{ fontSize: 11 }}>
                <div style={{ marginBottom: 8, color: "var(--grey-3)" }}>
                  <b>{t("ad.rtosHead")}:</b> {drMind.rtos?.configured ?? t("ad.rtosNone")}
                  （{t("ad.rtosDefault")}: {drMind.rtos?.default_runtime ?? "?"}）
                  · {t("ad.rtosAvail")}: {(drMind.rtos?.available ?? []).map((r) => r.name).join(" / ") || "—"}
                </div>
                {drMem.length > 0 && (
                  <div style={{ marginBottom: 10 }}>
                    <b style={{ color: "var(--grey-3)" }}>{t("ad.memMap")}</b>
                    <div className="pin-grid" style={{ marginTop: 4 }}>
                      {drMem.map((r, i) => (
                        <div key={i} className="pin-cell"><b>{r.region}</b><div>{r.origin}</div>
                          <div style={{ color: "var(--grey-3)" }}>{r.length}</div></div>
                      ))}
                    </div>
                  </div>
                )}
                <b style={{ color: "var(--grey-3)" }}>{t("ad.pinsHead")} ({drPins.length})</b>
                <div className="pin-grid" style={{ marginTop: 4 }}>
                  {drPins.map((pn, i) => (
                    <div key={i} className="pin-cell"><b>{pn.pad}</b><div>{pn.function}</div>
                      <div style={{ color: "var(--grey-3)" }}>{pn.group}</div></div>
                  ))}
                </div>
              </div>
            ) : peripherals.length > 0 ? (
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
              <div style={{ color: "var(--grey-3)", marginBottom: 8 }}>{t("ad.buildHint")} <code>{howto?.sample_entry ?? projectPath}</code>
                {howto?.board_arg ? <span> · BOARD=<code>{howto.board_arg}</code></span> : null}</div>
              {howto?.command && <pre className="pet-code" style={{ marginBottom: 8 }}>{howto.command}</pre>}
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
          {tab === "wiki" && (() => {
            const refs = ((char["mind"] ?? {}) as { references?: Array<{ title?: string; url?: string; content_md?: string | null; fetched_at?: string; note?: string }> }).references ?? [];
            return (
              <div style={{ fontSize: 11 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ color: "var(--grey-3)", flex: 1 }}>{t("ad.wikiHint")}</span>
                  <button className="ft-btn" disabled={wikiBusy} onClick={() => void refreshWiki()}>
                    {wikiBusy ? "⏳…" : `↻ ${t("ad.wikiRefresh")}`}
                  </button>
                </div>
                {refs.length === 0 && <div style={{ color: "var(--grey-3)" }}>{t("ad.wikiNone")}</div>}
                {refs.map((r, i) => (
                  <div key={i} style={{ border: "1px solid var(--border)", borderRadius: 4, marginBottom: 6 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", cursor: "pointer" }}
                      onClick={() => setOpenRef(openRef === i ? -1 : i)}>
                      <span>{r.content_md ? "📄" : "🔗"}</span>
                      <b style={{ flex: 1 }}>{r.title}</b>
                      <span style={{ color: "var(--grey-3)", fontSize: 9.5 }}>{r.fetched_at ?? r.note ?? ""}</span>
                      <span style={{ color: "var(--grey-3)" }}>{openRef === i ? "▾" : "▸"}</span>
                    </div>
                    {openRef === i && (
                      r.content_md
                        ? <div style={{ padding: "4px 10px 10px", maxHeight: 260, overflow: "auto", fontSize: 10.5, lineHeight: 1.6 }}
                            dangerouslySetInnerHTML={{ __html: mdLite(r.content_md.slice(0, 8000)) }} />
                        : <div style={{ padding: "4px 10px 10px", color: "var(--grey-3)" }}>{r.url}</div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}
          {tab === "journal" && (() => {
            const mind = (char["mind"] ?? {}) as { memory?: Array<{ symptom?: string; fix?: string; origin?: string; date?: string }> };
            const journal = (char["journal"] ?? {}) as { history?: Array<{ kind?: string; goal?: string; verdict?: string; when?: string; root_cause?: string; category?: string }> };
            const memory = mind.memory ?? [];
            const hist = journal.history ?? [];
            return (
              <div style={{ fontSize: 11 }}>
                <div style={{ fontWeight: 700, color: "var(--grey-3)", marginBottom: 4 }}>{t("ad.memHead")} ({memory.length})</div>
                {memory.map((m, i) => (
                  <div key={i} style={{ padding: "3px 0", borderBottom: "1px solid var(--grey-1)" }}>
                    <b>{m.symptom?.slice(0, 110)}</b>
                    <div style={{ color: "var(--grey-3)" }}>→ {m.fix?.slice(0, 130)} <span className="mod-chip" style={{ fontSize: 8 }}>{m.origin}</span></div>
                  </div>
                ))}
                <div style={{ display: "flex", gap: 4, marginTop: 8 }}>
                  <input className="flux-input mono" style={{ flex: 1 }} placeholder={t("ad.lessonSymPh")}
                    value={lessonSym} onChange={(e) => setLessonSym(e.target.value)} />
                  <input className="flux-input mono" style={{ flex: 1 }} placeholder={t("ad.lessonFixPh")}
                    value={lessonFix} onChange={(e) => setLessonFix(e.target.value)} />
                  <button className="ft-btn" onClick={() => void addLesson()}>＋ {t("ad.lessonAdd")}</button>
                </div>
                <div style={{ fontWeight: 700, color: "var(--grey-3)", margin: "12px 0 4px" }}>{t("ad.histHead")} ({hist.length})</div>
                {hist.slice(-15).reverse().map((h, i) => (
                  <div key={i} style={{ fontFamily: "var(--mono)", fontSize: 10, padding: "2px 0", color: "var(--grey-3)" }}>
                    <span className="mod-chip" style={{ fontSize: 8 }}>{h.kind}</span> {h.when ?? ""} {h.verdict ?? h.category ?? ""} {String(h.goal ?? h.root_cause ?? "").slice(0, 70)}
                  </div>
                ))}
              </div>
            );
          })()}
          {tab === "file" && (
            <div style={{ fontSize: 11 }}>
              <div style={{ color: "var(--grey-3)", marginBottom: 6 }}>{t("ad.fileHint")}</div>
              <div className="pin-cell" style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                <span style={{ fontFamily: "var(--mono)", flex: 1, wordBreak: "break-all" }}>{fluxPath}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button className="ft-btn" onClick={() => copy(fluxPath, t("ad.copiedPath"))}>📋 {t("ad.copyPath")}</button>
                <button className="ft-btn" onClick={() => copy(`.flux/devready/${board}.flux.json`, t("ad.copiedRel"))}>📋 {t("ad.copyRel")}</button>
                <button className="ft-btn" onClick={() => copy(JSON.stringify(full, null, 1), t("ad.copiedContent"))}>📋 {t("ad.copyContent")}</button>
                {revealInExplorer && <button className="ft-btn" onClick={() => revealInExplorer(fluxPath.replace("~", ""))}>📂 {t("ad.reveal")}</button>}
              </div>
              <div style={{ marginTop: 14, color: "var(--grey-3)", fontSize: 10, lineHeight: 1.6 }}>
                {t("ad.fileSpec")}
              </div>
            </div>
          )}
          {tab === "props" && (
            <pre className="code-view" style={{ maxHeight: 380, fontSize: 10.5 }}>
              {JSON.stringify(full ?? { loading: true }, null, 2).slice(0, 12000)}
            </pre>
          )}
        </div>
        {note && <div style={{ padding: "6px 14px", fontSize: 10.5, color: note.startsWith("✓") ? "#2e7d32" : "#b91c1c", borderTop: "1px solid var(--border)" }}>{note}</div>}
      </div>
    </div>
  );
}
