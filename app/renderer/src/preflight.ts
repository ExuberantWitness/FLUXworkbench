// Preflight — the pet's "lab partner" instincts (deterministic, no LLM).
//
// Two kinds of instincts:
//   1. checks: run when the user HOVERS a consequential button (before the
//      click) — read observable state (panel data-* attrs + recent bus
//      events) and return short tips/warnings. Zero latency, zero
//      hallucination: every rule is a pure function.
//   2. suggestions: run when a bus event lands — the partner leans over and
//      says "now you could…". One-shot per condition.
//
// Panel state travels via data-* attributes on the panel root (e.g.
// MissionPanel sets data-board/data-backend/data-present) so rules can read
// the LIVE selection without lifting React state.

interface FluxEvent { topic: string; data: Record<string, unknown>; trace_id: string }

export interface PreflightCtx {
  events: FluxEvent[];
  /** closest panel root carrying data-* state, from the hovered element */
  attr: (name: string) => string;
}

export interface PreflightRule {
  /** data-guide id of the guarded control */
  guide: string;
  check: (ctx: PreflightCtx) => string[]; // i18n keys or literal strings ("!"-prefixed = literal)
}

const last = <T>(arr: T[]): T | undefined => arr[arr.length - 1];

export const PREFLIGHT_RULES: PreflightRule[] = [
  {
    guide: "mission-start",
    check: (ctx) => {
      const tips: string[] = [];
      const board = ctx.attr("data-board");
      const backend = ctx.attr("data-backend");
      const present = ctx.attr("data-present").split(",").filter(Boolean);
      if (present.length && board && !present.includes(board)) {
        tips.push("pf.boardMismatch");
        tips.push(`!→ ${present.join(" / ")}`); // "!" = literal line (plugged-in boards)
      }
      if (backend === "mock" && present.length && present.includes(board)) {
        tips.push("pf.mockButReal");
      }
      if (backend === "real" && !present.length) {
        tips.push("pf.realButAbsent");
      }
      const fails = ctx.events.filter((e) =>
        e.topic === "mission.milestone"
        && (e.data as { phase?: string; status?: string }).phase === "mission"
        && (e.data as { status?: string }).status === "fail").length;
      if (fails >= 1) tips.push("pf.priorMissionFail");
      return tips;
    },
  },
  {
    guide: "ad-build",
    check: (ctx) => {
      const tips: string[] = [];
      const lastBuild = last(ctx.events.filter((e) => e.topic === "build.progress"
        && (e.data as { phase?: string }).phase === "done"));
      if (lastBuild && (lastBuild.data as { ok?: boolean }).ok === false) tips.push("pf.lastBuildFailed");
      return tips;
    },
  },
  {
    guide: "up-train",
    check: (ctx) => {
      const tips: string[] = [];
      if (ctx.attr("data-gpu") === "0") tips.push("pf.noGpuTrain");
      if (ctx.attr("data-spec") === "0") tips.push("pf.noSpec");
      const live = ctx.events.some((e) => e.topic === "training.started")
        && !ctx.events.some((e) => e.topic === "training.finished");
      if (live) tips.push("pf.trainLive");
      return tips;
    },
  },
  {
    guide: "asset-export",
    check: (ctx) => {
      const committed = ctx.events.filter((e) => e.topic === "asset.committed").length;
      return committed === 0 ? ["pf.nothingToExport"] : [];
    },
  },
  {
    guide: "dev-authorize",
    check: () => ["pf.authWhat"],
  },
  {
    guide: "alarm-demo",
    check: () => ["pf.alarmWhat"],
  },
];

// ── proactive partner suggestions: event pattern → one-shot tip ──
export interface Suggestion {
  id: string; // dedup key
  when: (events: FluxEvent[]) => boolean;
  tipKey: string;
  highlight?: string; // optional data-guide to pulse once
}

export const SUGGESTIONS: Suggestion[] = [
  {
    id: "real-attached",
    when: (ev) => ev.some((e) => e.topic === "device.attached" && (e.data as { real?: boolean }).real === true),
    tipKey: "pf.suggestRealBackend",
    highlight: "mission-start",
  },
  {
    id: "characterized-only",
    when: (ev) => ev.some((e) => e.topic === "mission.milestone"
      && (e.data as { phase?: string; status?: string; detail?: string }).phase === "verify"
      && String((e.data as { detail?: string }).detail ?? "").startsWith("characterized")),
    tipKey: "pf.suggestRealHil",
  },
  {
    id: "first-asset",
    when: (ev) => ev.filter((e) => e.topic === "asset.committed").length === 1,
    tipKey: "pf.suggestExport",
    highlight: "asset-export",
  },
];
