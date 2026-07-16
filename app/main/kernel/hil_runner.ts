// HilRunner — executes an asset-derived HIL test plan against a DeviceBackend.
//
// Deliberately NOT WorkflowRunner: HIL needs result capture, structured asserts,
// per-step deps (topo order), and trace_id-correlated probes — cmd-name matching
// would cross-talk between same-op steps. Runs are announced on hil.plan /
// hil.step / hil.report; a workflow.published event mirrors the step DAG so the
// existing Flow Axis visualization lights up unchanged.

import type { Bus } from "./bus";
import { makeBackend } from "./device_backend";
import {
  evalAssert, parseProbeReply, topoOrder, validatePlan,
  type HilReport, type HilStepResult, type HilTestPlan,
} from "./hil_types";
import type { BuildResult } from "../build_service";

type BuildFn = (sampleDir: string) => Promise<BuildResult>;

export class HilRunner {
  private seq = 0;

  constructor(
    private readonly bus: Bus,
    private readonly build: BuildFn,
  ) {}

  async run(plan: HilTestPlan): Promise<HilReport> {
    const errs = validatePlan(plan);
    if (errs.length) throw new Error(`invalid plan: ${errs.join("; ")}`);

    const runId = `hil-${Date.now()}-${++this.seq}`;
    const backend = makeBackend(plan.target.backend, this.bus);
    const startedAt = new Date().toISOString();
    const results = new Map<string, HilStepResult>();
    const ordered = topoOrder(plan.steps);

    await this.publish("hil.plan", { runId, plan: plan as unknown as Record<string, unknown> });
    // Mirror as a workflow so the existing DAG view renders the run.
    await this.publish("workflow.published", {
      name: plan.name,
      steps: ordered.map((s) => ({ name: s.id, op: `hil.${s.type}`, deps: s.deps ?? [] })),
    });

    let failed = false;
    for (const step of ordered) {
      const depFailed = (step.deps ?? []).some((d) => {
        const r = results.get(d);
        return !r || r.status === "fail" || r.status === "error" || r.status === "skipped";
      });
      const t0 = Date.now();
      let res: HilStepResult;
      if (depFailed) {
        res = { id: step.id, type: step.type, status: "skipped", durationMs: 0, detail: {} };
      } else {
        res = await this.execStep(step, plan, results, backend, runId);
        res.durationMs = Date.now() - t0;
      }
      results.set(step.id, res);
      if (res.status === "fail" || res.status === "error") failed = true;
      await this.publish("hil.step", {
        runId, stepId: step.id, type: step.type, status: res.status,
        detail: res.detail as unknown as Record<string, unknown>,
        assertion: res.assertion as unknown as Record<string, unknown>,
      });
    }

    const stepResults = ordered.map((s) => results.get(s.id)!) ;
    const passed = stepResults.filter((r) => r.status === "pass").length;
    const report: HilReport = {
      schema: "flux.hil.report/v1",
      runId,
      planName: plan.name,
      goal: plan.goal,
      mode: plan.target.backend,
      board: plan.target.board,
      startedAt,
      finishedAt: new Date().toISOString(),
      steps: stepResults,
      summary: {
        total: stepResults.length,
        passed,
        failed: stepResults.filter((r) => r.status === "fail" || r.status === "error").length,
        verdict: failed ? "FAIL" : "PASS",
      },
    };
    await this.publish("hil.report", report as unknown as Record<string, unknown>);
    backend.close?.();
    return report;
  }

  private async execStep(
    step: HilTestPlan["steps"][number],
    plan: HilTestPlan,
    results: Map<string, HilStepResult>,
    backend: ReturnType<typeof makeBackend>,
    runId: string,
  ): Promise<HilStepResult> {
    const base: HilStepResult = { id: step.id, type: step.type, status: "pass", durationMs: 0, detail: {} };
    const traceId = `${runId}-${step.id}`;
    // LLM-generated plans occasionally omit `params` (e.g. a bare reset step);
    // default it so every `step.params.X` access below is safe, not a crash.
    step.params = step.params ?? {};
    try {
      switch (step.type) {
        case "build": {
          const r = await this.build(step.params.sampleDir ?? "");
          base.detail.raw = r.ok ? "build ok" : (r.error ?? "build failed");
          base.detail.elf = r.elf;
          if (!r.ok) base.status = "fail";
          break;
        }
        case "flash": {
          let elf = step.params.elf ?? "";
          if (elf.startsWith("$")) {
            const [sid] = elf.slice(1).split(".");
            elf = results.get(sid ?? "")?.detail.elf ?? elf;
          }
          base.detail.raw = await backend.flash(elf, traceId);
          base.detail.elf = elf;
          if (/error|fail/i.test(base.detail.raw)) base.status = "fail";
          break;
        }
        case "reset":
          base.detail.raw = await backend.reset(step.params.run ?? true, traceId);
          break;
        case "probe": {
          const raw = await backend.probe({
            op: step.params.op ?? (step.params.reg ? "read_reg" : "read_mem"),
            reg: step.params.reg, addr: step.params.addr, count: step.params.count,
          }, traceId);
          const parsed = parseProbeReply(raw, step.params.wordIndex ?? 0);
          base.detail.raw = parsed.raw;
          base.detail.value = parsed.value;
          break;
        }
        case "sim_probe": {
          // Physical quantity from the Newton co-sim bridge's state file.
          const { readFileSync } = await import("node:fs");
          const statePath = process.env["FLUX_SIM_STATE"]
            ?? `${process.env["HOME"]}/.flux/sim/state.json`;
          const state = JSON.parse(readFileSync(statePath, "utf8")) as {
            quantities?: Record<string, number>;
          };
          const q = step.params.quantity ?? "";
          const v = state.quantities?.[q];
          if (v === undefined) throw new Error(`sim state has no quantity: ${q}`);
          base.detail.raw = `${q} = ${v}`;
          base.detail.value = v;
          break;
        }
        case "assert": {
          const expr = step.params.expr!;
          const v = evalAssert(expr, results);
          base.assertion = { op: expr.op, expected: v.expected, actual: v.actual };
          base.detail.raw = step.params.message ?? "";
          if (!v.pass) base.status = "fail";
          break;
        }
        case "wait":
          await new Promise((r) => setTimeout(r, step.params.ms ?? 100));
          base.detail.raw = `waited ${step.params.ms ?? 100}ms`;
          break;
      }
    } catch (e) {
      base.status = "error";
      base.detail.error = (e as Error).message;
    }
    return base;
  }

  private publish(topic: string, data: Record<string, unknown>): Promise<void> {
    return this.bus.publish({
      source: "hil-runner", kind: "execute", topic, data, trace_id: `hil-${Date.now()}`,
    });
  }
}
