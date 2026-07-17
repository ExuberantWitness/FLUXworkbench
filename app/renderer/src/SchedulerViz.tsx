// Live view of the microkernel scheduler — the thing that makes Flux Workbench
// not "another VSCode". VSCode runs commands FIFO with no notion of priority;
// here every task holds a slot in an RTOS-style priority queue, and a hardware
// alarm (probe-loss, over-current) preempts every software task below the
// Device band. This panel renders the *real* scheduler.state the kernel
// publishes on every acquire/release/pause/resume — inflight, queued, frozen.
import React from "react";
import { useLang } from "./i18n";

export interface SchedulerState {
  maxConcurrent: number;
  inflight: number;
  pauseFloor: number;
  inflightCalls: Array<{ prio: number; tool: string }>;
  queued: Array<{ prio: number; tool: string }>;
}

interface Band { level: number; zh: string; en: string; color: string }
const BANDS: Band[] = [
  { level: 90, zh: "告警 Alarm", en: "Alarm", color: "#ff4444" },
  { level: 70, zh: "设备 Device", en: "Device", color: "#ff8800" },
  { level: 50, zh: "在环 HIL", en: "HIL", color: "#c77dff" },
  { level: 30, zh: "Agent / 构建 / 资产", en: "Agent / Build / Asset", color: "#5B7BFF" },
  { level: 10, zh: "后台 Background", en: "Background", color: "#00aa44" },
];

export function SchedulerViz({ state, onDemo, demoLabel }: {
  state: SchedulerState | null;
  onDemo?: () => void;
  demoLabel?: string;
}): React.ReactElement {
  const { lang } = useLang();
  const zh = lang === "zh";
  const s: SchedulerState = state ?? { maxConcurrent: 2, inflight: 0, pauseFloor: 0, inflightCalls: [], queued: [] };
  const floor = s.pauseFloor;
  const preempting = floor > 0;

  // The alarm band shows the live preemption source while the floor is raised.
  const alarmChip = preempting ? [{ prio: 90, tool: zh ? "⚡ 探针失联 probe-loss" : "⚡ probe-loss" }] : [];

  return (
    <div data-viz="scheduler" style={{ border: "1px solid var(--border)", borderRadius: 6, background: "var(--paper)", overflow: "hidden", flexShrink: 0 }}>
      <style>{`
        @keyframes sv-pulse { 0%,100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); } 50% { box-shadow: 0 0 8px 1px currentColor; } }
        @keyframes sv-flash { 0%,100% { opacity: 1; } 50% { opacity: .45; } }
        .sv-fly { animation: sv-pulse 1.1s ease-in-out infinite; }
        .sv-alarm-hdr { animation: sv-flash .8s ease-in-out infinite; }
      `}</style>

      {/* header: what the scheduler is + live slot / preemption state */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 12px", borderBottom: "1px solid var(--border)", background: "var(--grey-1, rgba(0,0,0,.03))" }}>
        <span style={{ fontSize: 13, fontWeight: 800 }}>🧬 {zh ? "内核调度器" : "Kernel scheduler"}</span>
        <span style={{ fontSize: 10.5, color: "var(--grey-3)" }}>{zh ? "RTOS 优先级抢占 · 有界并发" : "RTOS priority preemption · bounded concurrency"}</span>
        <span style={{ marginLeft: "auto", fontSize: 11, fontFamily: "var(--mono, monospace)", color: "var(--grey-3)" }}>
          {zh ? "槽位" : "slots"} <b style={{ color: "var(--ink)" }}>{s.inflight}/{s.maxConcurrent}</b>
        </span>
        {preempting && (
          <span className="sv-alarm-hdr" style={{ fontSize: 11, fontWeight: 700, color: "#fff", background: "#b71c1c", padding: "2px 8px", borderRadius: 4, fontFamily: "var(--mono, monospace)" }}>
            {zh ? `⚡ 抢占线 ${floor}` : `⚡ preempt floor ${floor}`}
          </span>
        )}
        {onDemo && (
          <button className="chat-send" style={{ fontSize: 11 }} onClick={onDemo}>
            {demoLabel ?? (zh ? "▶ 调度演示" : "▶ Run demo")}
          </button>
        )}
      </div>

      {/* band lanes, highest priority on top */}
      <div style={{ display: "flex", flexDirection: "column" }}>
        {BANDS.map((b) => {
          const fly = (b.level === 90 ? alarmChip : s.inflightCalls.filter((c) => c.prio === b.level));
          const wait = s.queued.filter((c) => c.prio === b.level);
          const frozen = preempting && b.level < floor;
          const idle = fly.length === 0 && wait.length === 0;
          return (
            <div key={b.level} style={{
              display: "flex", alignItems: "center", gap: 10, padding: "8px 12px",
              borderBottom: "1px solid var(--border)",
              opacity: frozen ? 0.72 : idle ? 0.55 : 1,
              background: frozen ? "rgba(183,28,28,.06)" : "transparent",
              transition: "opacity .25s, background .25s",
            }}>
              {/* level badge + name */}
              <div style={{ width: 128, flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontFamily: "var(--mono, monospace)", fontWeight: 800, fontSize: 13, color: b.color, minWidth: 22, textAlign: "right" }}>{b.level}</span>
                <span style={{ fontSize: 10.5, color: "var(--grey-3)", lineHeight: 1.1 }}>{zh ? b.zh : b.en}</span>
              </div>

              {/* task chips */}
              <div style={{ flex: 1, display: "flex", flexWrap: "wrap", gap: 6, minHeight: 22, alignItems: "center" }}>
                {fly.map((c, i) => (
                  <span key={`f${i}`} className="sv-fly" style={{
                    color: b.color, fontSize: 11, fontWeight: 600, fontFamily: "var(--mono, monospace)",
                    background: b.color, borderRadius: 4, padding: "2px 8px",
                    // filled chip: label in white on the band color
                  }}>
                    <span style={{ color: "#fff" }}>▶ {c.tool}</span>
                  </span>
                ))}
                {wait.map((c, i) => (
                  <span key={`w${i}`} style={{
                    fontSize: 11, fontFamily: "var(--mono, monospace)",
                    color: frozen ? "#c62828" : "var(--grey-3)",
                    border: `1px dashed ${frozen ? "#c62828" : "var(--grey-2)"}`,
                    borderRadius: 4, padding: "1px 7px",
                  }}>
                    {frozen ? "❄" : "⏳"} {c.tool}
                  </span>
                ))}
                {frozen && wait.length > 0 && (
                  <span style={{ fontSize: 10, fontWeight: 700, color: "#c62828", marginLeft: 2 }}>
                    {zh ? "冻结 · 硬件优先" : "FROZEN · hardware first"}
                  </span>
                )}
                {idle && <span style={{ fontSize: 10.5, color: "var(--grey-2)" }}>—</span>}
              </div>
            </div>
          );
        })}
      </div>

      {/* first-principle: why the substrate is a real-time kernel */}
      <div style={{ padding: "7px 12px", fontSize: 10.5, color: "var(--grey-3)", lineHeight: 1.5 }}>
        {zh
          ? "实时内核：任务按物理优先级调度，有限槽位。硬件告警冻结软件任务，设备事件抢占先跑——硬件不等人。"
          : "A real-time kernel: tasks scheduled by physical priority in bounded slots. A hardware alarm freezes software tasks and device events preempt to run first — hardware doesn't wait."}
      </div>
    </div>
  );
}
