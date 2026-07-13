// Problems drawer — build.diagnostic lines + Sentinel triage cards + manual triage.
import React, { useMemo, useState } from "react";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

interface Diag { file: string; line: number; col: number; severity: string; message: string; source: string }
interface Triage {
  category: string; root_cause: string; confidence: number;
  affected_files?: Array<{ path: string; line?: number; reason?: string }>;
  suggested_fixes?: Array<{ title: string; detail?: string }>;
  raw_excerpt?: string; source: string; asset_id?: string;
}

export function ProblemsPanel({ events, openFile }: {
  events: FluxEvent[];
  openFile?: (path: string) => void;
}): React.ReactElement {
  const [pasted, setPasted] = useState("");
  const [busy, setBusy] = useState(false);
  const flux = (window as unknown as {
    flux: { triage(text: string, ctx?: Record<string, unknown>): Promise<unknown> };
  }).flux;

  const diags = useMemo(
    () => events.filter((e) => e.topic === "build.diagnostic").map((e) => e.data as unknown as Diag).slice(-40),
    [events]);
  const triages = useMemo(
    () => events.filter((e) => e.topic === "triage.result").map((e) => e.data as unknown as Triage).slice(-5).reverse(),
    [events]);

  const doTriage = async (): Promise<void> => {
    if (!pasted.trim()) return;
    setBusy(true);
    try { await flux.triage(pasted, {}); setPasted(""); } finally { setBusy(false); }
  };

  return (
    <div style={{ display: "flex", gap: 10, padding: 8, height: "100%", overflow: "hidden", fontSize: 11 }}>
      <div style={{ flex: 1, overflow: "auto", minWidth: 0 }}>
        <div style={{ color: "#888", marginBottom: 4, fontWeight: 600 }}>DIAGNOSTICS ({diags.length})</div>
        {diags.length === 0 && <div style={{ color: "#555" }}>no build diagnostics</div>}
        {diags.map((d, i) => (
          <div key={i} onClick={() => d.file && openFile?.(d.file)}
            style={{ cursor: d.file ? "pointer" : "default", fontFamily: "var(--mono, monospace)", padding: "2px 0",
                     color: d.severity === "error" ? "#f44336" : "#ff9800", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {d.severity === "error" ? "✗" : "⚠"} {d.file}:{d.line} — {d.message}
          </div>
        ))}
      </div>
      <div style={{ flex: 1.2, overflow: "auto", minWidth: 0 }}>
        <div style={{ color: "#888", marginBottom: 4, fontWeight: 600 }}>SENTINEL TRIAGE</div>
        {triages.length === 0 && <div style={{ color: "#555" }}>no triage results — failures land here automatically</div>}
        {triages.map((t, i) => (
          <div key={i} className="rp-card" style={{ marginBottom: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontWeight: 700, color: "#ff9800" }}>{t.category}</span>
              <span style={{ color: "#666" }}>{t.source}</span>
              <div style={{ marginLeft: "auto", width: 60, height: 5, background: "#333", borderRadius: 3 }}>
                <div style={{ width: `${Math.round((t.confidence ?? 0) * 60)}px`, height: 5, background: (t.confidence ?? 0) > 0.6 ? "#4caf50" : "#ff9800", borderRadius: 3 }} />
              </div>
            </div>
            <div style={{ marginTop: 3 }}>{t.root_cause}</div>
            {t.affected_files?.map((f, j) => (
              <div key={j} onClick={() => openFile?.(f.path)} style={{ cursor: "pointer", color: "#64b5f6", fontFamily: "var(--mono, monospace)" }}>
                → {f.path}{f.line ? `:${f.line}` : ""} {f.reason ? `(${f.reason})` : ""}
              </div>
            ))}
            {t.suggested_fixes?.map((f, j) => (
              <div key={j} style={{ color: "#a5d6a7", marginTop: 2 }}>💡 {f.title}{f.detail ? ` — ${f.detail}` : ""}</div>
            ))}
            {t.asset_id && <div style={{ color: "#555", marginTop: 2 }}>case → {t.asset_id}</div>}
          </div>
        ))}
      </div>
      <div style={{ width: 260, display: "flex", flexDirection: "column", gap: 4 }}>
        <div style={{ color: "#888", fontWeight: 600 }}>MANUAL TRIAGE</div>
        <textarea value={pasted} onChange={(e) => setPasted(e.target.value)}
          placeholder="paste any error output…"
          style={{ flex: 1, background: "var(--grey-6, #161616)", color: "inherit", border: "1px solid #333", borderRadius: 4, padding: 6, fontFamily: "var(--mono, monospace)", fontSize: 10.5, resize: "none" }} />
        <button className="chat-send" disabled={busy || !pasted.trim()} onClick={() => void doTriage()}>
          {busy ? "…" : "🔍 Triage"}
        </button>
      </div>
    </div>
  );
}
