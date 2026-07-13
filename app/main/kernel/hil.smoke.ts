// HIL runner smoke — full mock loop, no studio needed.
//   npx esbuild app/main/kernel/hil.smoke.ts --bundle --platform=node \
//     --outfile=/tmp/hil-smoke.cjs && node /tmp/hil-smoke.cjs
//
// Phase 1: healthy scenario → gpio_smoke plan must PASS (LED toggles).
// Phase 2: fault scenario (GPIO clock dead) → toggle assert must FAIL.

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { InProcessBus } from "./bus";
import { OpenOcdAgent } from "./agents/openocd";
import { HilRunner } from "./hil_runner";
import type { HilTestPlan } from "./hil_types";

// Bundled output relocates __dirname — run from the repo root or set FLUX_REPO.
const repo = process.env["FLUX_REPO"] ?? process.cwd();
const MOCK_CLI = path.join(repo, "spike", "mock-openocd-cli.py");
const PLAN = JSON.parse(
  readFileSync(path.join(repo, "examples", "hil", "gpio_smoke.json"), "utf8"),
) as HilTestPlan;

async function runScenario(scenario: string): Promise<{ verdict: string; failed: string[] }> {
  const bus = new InProcessBus();
  const agent = new OpenOcdAgent(bus);
  process.env["FLUX_MOCK_SCENARIO"] = path.join(repo, "spike", "mock-scenarios", scenario);
  await agent.startMock("python3", [MOCK_CLI]);
  const runner = new HilRunner(bus, async () => ({ ok: true, elf: "fake.elf" }));
  const report = await runner.run(PLAN);
  await agent.stop();
  return {
    verdict: report.summary.verdict,
    failed: report.steps.filter((s) => s.status !== "pass").map((s) => `${s.id}:${s.status}`),
  };
}

async function main(): Promise<void> {
  const healthy = await runScenario("stm32f103_default.json");
  console.log("healthy:", JSON.stringify(healthy));
  if (healthy.verdict !== "PASS") throw new Error("healthy scenario should PASS");

  const fault = await runScenario("stm32f103_fault.json");
  console.log("fault:  ", JSON.stringify(fault));
  if (fault.verdict !== "FAIL") throw new Error("fault scenario should FAIL");
  if (!fault.failed.some((f) => f.startsWith("toggle:fail"))) {
    throw new Error(`fault should fail at 'toggle', got: ${fault.failed.join(",")}`);
  }

  console.log("hil.smoke: ALL OK");
  process.exit(0);
}

main().catch((e) => { console.error("hil.smoke FAILED:", e.message); process.exit(1); });
