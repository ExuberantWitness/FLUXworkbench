// PhysicalDevBench runner (P4) — the built-in 考场.
//
// For each (task × model-preset × condition) it: pins the text channel to the
// preset (keys never leave the brain), asks gen_test_plan for a plan (bare =
// model memory only, with_assets = register-map slice injected), runs the plan
// through the real HilRunner, and scores assert-pass rate. The bare-vs-assets
// score delta IS the asset store's pricing anchor; the model column doubles as
// BD material (MiMo rides the "vision" preset).

import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import type { MCPOrchestrator } from "../mcp_orchestrator";
import type { Bus } from "./bus";
import type { HilRunner } from "./hil_runner";
import { validatePlan, type HilTestPlan } from "./hil_types";
import { mcpText } from "./golden_path";

export interface BenchTask {
  id: string;
  goal: string;
  chip: string;
  board: string;
  backend: "mock" | "real" | "sim";
  conditions?: string[];
  description?: string;
}

export interface BenchResult {
  task: string;
  model: string;
  preset: string;
  condition: string;
  score: number;
  passed: number;
  total: number;
  error?: string;
}

// Default matrix: light + heavy (DeepSeek tiers) + vision (MiMo) — presets
// resolve inside the brain from llm.json, so this list carries no secrets.
const DEFAULT_PRESETS = ["light", "heavy", "vision"];

export class BenchRunner {
  constructor(
    private bus: Bus,
    private mcp: MCPOrchestrator,
    private hil: HilRunner,
    private benchDir: string,
  ) {}

  listTasks(): BenchTask[] {
    if (!existsSync(this.benchDir)) return [];
    const out: BenchTask[] = [];
    for (const f of readdirSync(this.benchDir).filter((f) => f.endsWith(".json"))) {
      try {
        const t = JSON.parse(readFileSync(path.join(this.benchDir, f), "utf8")) as BenchTask;
        if (t.id && t.goal) out.push(t);
      } catch { /* malformed task file — skip */ }
    }
    return out;
  }

  async run(taskIds?: string[], presets?: string[]): Promise<BenchResult[]> {
    const tasks = this.listTasks().filter((t) => !taskIds?.length || taskIds.includes(t.id));
    const models = presets?.length ? presets : DEFAULT_PRESETS;
    const results: BenchResult[] = [];

    for (const preset of models) {
      // Pin the text channel; on unknown preset (e.g. no tiers configured) skip.
      let modelName = preset;
      try {
        const r = JSON.parse(mcpText(await this.mcp.callTool("set_api_config", { preset }, 50)));
        modelName = String(r["model"] ?? preset);
      } catch (e) {
        results.push(...tasks.map((t) => ({
          task: t.id, model: preset, preset, condition: "-", score: 0, passed: 0, total: 0,
          error: `preset unavailable: ${(e as Error).message.slice(0, 80)}`,
        })));
        continue;
      }

      for (const task of tasks) {
        for (const condition of task.conditions ?? ["bare", "with_assets"]) {
          const res = await this.runOne(task, modelName, preset, condition);
          results.push(res);
          await this.commitResult(res);
        }
      }
    }

    // Restore the user's configuration exactly as llm.json defines it.
    await this.mcp.callTool("set_api_config", { reload: true }, 50).catch(() => void 0);
    return results;
  }

  private async runOne(task: BenchTask, model: string, preset: string, condition: string): Promise<BenchResult> {
    const base: BenchResult = { task: task.id, model, preset, condition, score: 0, passed: 0, total: 0 };
    let plan: HilTestPlan;
    try {
      plan = JSON.parse(mcpText(await this.mcp.callTool("gen_test_plan", {
        goal: task.goal, chip: task.chip, board: task.board, backend: task.backend,
        use_assets: condition === "with_assets", pin_model: true,
      }, 30))) as HilTestPlan;
      const errs = validatePlan(plan);
      if (errs.length) return { ...base, error: `invalid plan: ${errs.join("; ").slice(0, 160)}` };
    } catch (e) {
      return { ...base, error: `plan gen failed: ${(e as Error).message.slice(0, 160)}` };
    }
    try {
      const report = await this.hil.run(plan);
      return {
        ...base,
        passed: report.summary.passed,
        total: report.summary.total,
        score: report.summary.total > 0 ? report.summary.passed / report.summary.total : 0,
      };
    } catch (e) {
      return { ...base, error: `run failed: ${(e as Error).message.slice(0, 160)}` };
    }
  }

  private async commitResult(r: BenchResult): Promise<void> {
    try {
      await this.mcp.callTool("commit_asset", {
        asset_id: `bench-${r.task}-${r.preset}-${r.condition}-${Date.now()}`,
        type: "bench-result",
        source: { kind: "physicaldevbench" },
        components: [r.task, r.model, r.condition],
        characterization: { ...r },
      }, 10);
      await this.bus.publish({
        source: "bench", kind: "measure", topic: "asset.committed",
        data: { asset_id: `bench-${r.task}`, type: "bench-result", score: r.score },
        trace_id: `bench-${Date.now()}`,
      });
    } catch (e) {
      console.warn("[bench] result commit failed:", (e as Error).message);
    }
  }
}
