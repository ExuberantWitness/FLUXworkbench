// Sim-backend smoke — the SAME HilRunner runs a plan against live Renode.
// Prereq: renode --disable-gui --port 3456 <asset-generated .resc>
//   npx esbuild app/main/kernel/hil_sim.smoke.ts --bundle --platform=node \
//     --outfile=/tmp/hil-sim-smoke.cjs && node /tmp/hil-sim-smoke.cjs

import { readFileSync } from "node:fs";
import * as path from "node:path";
import { InProcessBus } from "./bus";
import { HilRunner } from "./hil_runner";
import type { HilTestPlan } from "./hil_types";

const repo = process.env["FLUX_REPO"] ?? process.cwd();
const PLAN = JSON.parse(
  readFileSync(path.join(repo, "examples", "hil", "sim_reset_values.json"), "utf8"),
) as HilTestPlan;

async function main(): Promise<void> {
  const bus = new InProcessBus();
  const runner = new HilRunner(bus, async () => ({ ok: false, error: "no build in sim smoke" }));
  const report = await runner.run(PLAN);
  console.log("verdict:", report.summary.verdict);
  for (const s of report.steps) {
    console.log(` ${s.status.padEnd(5)} ${s.id}`,
      s.assertion ? `expected=${JSON.stringify(s.assertion.expected)} actual=${JSON.stringify(s.assertion.actual)}` : (s.detail.error ?? s.detail.raw ?? ""));
  }
  if (report.summary.verdict !== "PASS") { console.error("hil_sim.smoke FAILED"); process.exit(1); }
  console.log("hil_sim.smoke: ALL OK");
  process.exit(0);
}

main().catch((e) => { console.error("hil_sim.smoke FAILED:", e.message); process.exit(1); });
