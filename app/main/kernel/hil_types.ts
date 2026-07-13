// HIL test plan / report / assertion types (flux.hil.plan/v1).
//
// Plans are asset-driven: gen_test_plan derives probe addresses from
// register-map assets; the runner never trusts free-form model output —
// validatePlan() gates every plan before execution.

export type HilStepType = "build" | "flash" | "reset" | "probe" | "assert" | "wait" | "sim_probe";
export type HilBackendKind = "mock" | "real" | "sim";

export interface AssertExpr {
  lhs: string; // "$<stepId>.value" | "$<stepId>.raw"
  op: "eq" | "ne" | "lt" | "gt" | "in_range" | "mask_eq" | "matches";
  rhs: number | string | [number, number];
  mask?: number;
}

export interface HilStep {
  id: string;
  type: HilStepType;
  deps: string[];
  params: {
    // build
    sampleDir?: string;
    // flash — supports "$<buildStepId>.elf"
    elf?: string;
    // reset
    run?: boolean;
    // probe
    op?: "read_reg" | "read_mem";
    reg?: string;
    addr?: string;
    count?: number;
    wordIndex?: number;
    // sim_probe (phase 5b: physical quantity from the physics co-sim)
    quantity?: string;
    // assert
    expr?: AssertExpr;
    message?: string;
    // wait
    ms?: number;
  };
}

export interface HilTestPlan {
  schema: "flux.hil.plan/v1";
  name: string;
  goal: string;
  target: { backend: HilBackendKind; board: string; chip?: string };
  source_assets?: string[]; // asset ids the plan was derived from (flywheel provenance)
  steps: HilStep[];
}

export interface HilStepResult {
  id: string;
  type: HilStepType;
  status: "pass" | "fail" | "error" | "skipped";
  durationMs: number;
  detail: { raw?: string; value?: number; elf?: string; error?: string };
  assertion?: { op: string; expected: unknown; actual: unknown };
}

export interface HilReport {
  schema: "flux.hil.report/v1";
  runId: string;
  planName: string;
  goal: string;
  mode: HilBackendKind;
  board: string;
  startedAt: string;
  finishedAt: string;
  steps: HilStepResult[];
  summary: { total: number; passed: number; failed: number; verdict: "PASS" | "FAIL" };
}

const STEP_TYPES: HilStepType[] = ["build", "flash", "reset", "probe", "assert", "wait", "sim_probe"];
const ASSERT_OPS = ["eq", "ne", "lt", "gt", "in_range", "mask_eq", "matches"];

/** Validate an untrusted plan (LLM output / user JSON). Returns error strings; empty = valid. */
export function validatePlan(plan: unknown): string[] {
  const errs: string[] = [];
  const p = plan as Partial<HilTestPlan>;
  if (!p || typeof p !== "object") return ["plan is not an object"];
  if (p.schema !== "flux.hil.plan/v1") errs.push(`bad schema: ${String(p.schema)}`);
  if (!p.name) errs.push("missing name");
  if (!p.target?.backend || !["mock", "real", "sim"].includes(p.target.backend)) {
    errs.push("target.backend must be mock|real|sim");
  }
  if (!Array.isArray(p.steps) || p.steps.length === 0) {
    errs.push("steps must be a non-empty array");
    return errs;
  }
  const ids = new Set<string>();
  for (const s of p.steps) {
    if (!s.id) { errs.push("step missing id"); continue; }
    if (ids.has(s.id)) errs.push(`duplicate step id: ${s.id}`);
    ids.add(s.id);
    if (!STEP_TYPES.includes(s.type)) errs.push(`step ${s.id}: bad type ${String(s.type)}`);
    if (s.type === "assert") {
      const e = s.params?.expr;
      if (!e) errs.push(`step ${s.id}: assert missing params.expr`);
      else {
        if (!ASSERT_OPS.includes(e.op)) errs.push(`step ${s.id}: bad assert op ${String(e.op)}`);
        if (typeof e.lhs !== "string" || !e.lhs.startsWith("$")) {
          errs.push(`step ${s.id}: assert lhs must be a "$stepId.field" ref`);
        }
      }
    }
    if (s.type === "probe" && !s.params?.reg && !s.params?.addr) {
      errs.push(`step ${s.id}: probe needs params.reg or params.addr`);
    }
  }
  for (const s of p.steps) {
    for (const d of s.deps ?? []) {
      if (!ids.has(d)) errs.push(`step ${s.id}: unknown dep ${d}`);
    }
  }
  return errs;
}

/** Topological order, preserving plan order among ready steps (cycle → throw). */
export function topoOrder(steps: HilStep[]): HilStep[] {
  const order: HilStep[] = [];
  const done = new Set<string>();
  let progressed = true;
  while (order.length < steps.length && progressed) {
    progressed = false;
    for (const s of steps) {
      if (done.has(s.id)) continue;
      if ((s.deps ?? []).every((d) => done.has(d))) {
        order.push(s); done.add(s.id); progressed = true;
      }
    }
  }
  if (order.length < steps.length) {
    throw new Error("dependency cycle in test plan");
  }
  return order;
}

/** Normalize an OpenOCD-style probe reply into {raw, value, words}.
 *  Same parser for mock / real / Renode — all use OpenOCD output shapes:
 *    reg:  "pc (/32): 0x08000130"
 *    mdw:  "0x40013800: 000000c0 20000000"
 */
export function parseProbeReply(raw: string, wordIndex = 0): { raw: string; value?: number; words?: number[] } {
  const out: { raw: string; value?: number; words?: number[] } = { raw };
  const regMatch = raw.match(/:\s*(0x[0-9a-fA-F]+)\s*$/);
  const colon = raw.indexOf(":");
  if (colon >= 0) {
    const tail = raw.slice(colon + 1).trim();
    const words = tail.split(/\s+/)
      .map((w) => parseInt(w, 16))
      .filter((n) => !Number.isNaN(n));
    if (words.length > 0) {
      out.words = words;
      out.value = words[Math.min(wordIndex, words.length - 1)];
      return out;
    }
  }
  if (regMatch?.[1]) out.value = parseInt(regMatch[1], 16);
  return out;
}

/** Evaluate an assert expression against prior step results. */
export function evalAssert(
  expr: AssertExpr,
  results: Map<string, HilStepResult>,
): { pass: boolean; actual: unknown; expected: unknown } {
  const resolve = (ref: unknown): unknown => {
    if (typeof ref !== "string" || !ref.startsWith("$")) return ref;
    const [stepId, field = "value"] = ref.slice(1).split(".");
    const r = results.get(stepId ?? "");
    if (!r) throw new Error(`assert references unknown step: ${String(stepId)}`);
    return field === "raw" ? r.detail.raw : r.detail.value;
  };
  const lhs = resolve(expr.lhs);
  const rhs = resolve(expr.rhs);
  const masked = (v: unknown): number =>
    expr.mask !== undefined ? (Number(v) & expr.mask) : Number(v);
  switch (expr.op) {
    case "eq": return { pass: masked(lhs) === masked(rhs), actual: lhs, expected: rhs };
    case "ne": return { pass: masked(lhs) !== masked(rhs), actual: lhs, expected: rhs };
    case "lt": return { pass: Number(lhs) < Number(rhs), actual: lhs, expected: rhs };
    case "gt": return { pass: Number(lhs) > Number(rhs), actual: lhs, expected: rhs };
    case "in_range": {
      const [lo, hi] = expr.rhs as [number, number];
      const v = Number(lhs);
      return { pass: v >= lo && v <= hi, actual: lhs, expected: expr.rhs };
    }
    case "mask_eq":
      return { pass: (Number(lhs) & (expr.mask ?? 0xffffffff)) === Number(rhs), actual: lhs, expected: rhs };
    case "matches":
      return { pass: new RegExp(String(rhs)).test(String(lhs)), actual: lhs, expected: rhs };
  }
}
