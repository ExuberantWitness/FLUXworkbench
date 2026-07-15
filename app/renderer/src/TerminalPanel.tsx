// Bottom terminal drawer (VSCode-style) — one-shot command runner.
// Output arrives as term.output bus events; ↑/↓ walk command history.
import React, { useEffect, useRef, useState } from "react";
import { useLang } from "./i18n";

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

export function TerminalPanel({ events, cwd, condaBin }: { events: FluxEvent[]; cwd: string; condaBin?: string }): React.ReactElement {
  const { t } = useLang();
  const [cmd, setCmd] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const [histIdx, setHistIdx] = useState(-1);
  const outRef = useRef<HTMLDivElement>(null);
  const flux = (window as unknown as { flux: { termRun(cmd: string, cwd?: string, envBin?: string): Promise<boolean> } }).flux;

  const lines = events.filter((e) => e.topic === "term.output")
    .map((e) => e.data as { line?: string; kind?: string });

  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [lines.length]);

  const run = (): void => {
    const c = cmd.trim();
    if (!c) return;
    setHistory((h) => [...h.slice(-50), c]);
    setHistIdx(-1);
    setCmd("");
    void flux.termRun(c, cwd, condaBin);
  };

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === "Enter") run();
    else if (e.key === "ArrowUp") {
      const idx = histIdx < 0 ? history.length - 1 : Math.max(0, histIdx - 1);
      if (history[idx]) { setCmd(history[idx]!); setHistIdx(idx); }
      e.preventDefault();
    } else if (e.key === "ArrowDown") {
      const idx = histIdx + 1;
      if (idx >= history.length) { setCmd(""); setHistIdx(-1); }
      else { setCmd(history[idx]!); setHistIdx(idx); }
      e.preventDefault();
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
      <div ref={outRef} className="term-out">
        {lines.length === 0 && <span style={{ color: "var(--grey-3)" }}>{t("term.hint")} — cwd: {cwd}{condaBin ? ` · env: ${condaBin.split("/").slice(-2, -1)[0] ?? condaBin}` : ""}</span>}
        {lines.map((l, i) => (
          <div key={i} className={l.kind === "cmd" ? "term-cmd" : l.kind === "err" ? "term-err" : l.kind === "meta" ? "term-cmd" : ""}
            style={l.kind === "meta" ? { opacity: 0.6 } : undefined}>
            {String(l.line ?? "")}
          </div>
        ))}
      </div>
      <div className="term-in">
        <span className="term-prompt">❯</span>
        <input className="flux-input mono" style={{ flex: 1 }} value={cmd} spellCheck={false}
          placeholder={t("term.ph")} onChange={(e) => setCmd(e.target.value)} onKeyDown={onKey} />
      </div>
    </div>
  );
}
