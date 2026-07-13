// Co-sim smoke — the full multi-domain loop, end to end:
//   1. SimBackend.flash loads the real PID firmware ELF into Renode
//   2. sim_bridge locksteps Renode (electronic) with Newton (physical)
//   3. the SAME HilRunner asserts on BOTH domains (register probe + sim_probe)
// Prereq: renode --disable-gui --port 3456 <asset-generated .resc>
//   npx esbuild app/main/kernel/hil_cosim.smoke.ts --bundle --platform=node \
//     --outfile=/tmp/hil-cosim-smoke.cjs && node /tmp/hil-cosim-smoke.cjs

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { InProcessBus } from "./bus";
import { SimBackend } from "./device_backend";
import { HilRunner } from "./hil_runner";
import type { HilTestPlan } from "./hil_types";

const repo = process.env["FLUX_REPO"] ?? process.cwd();
const ELF = path.join(repo, "firmware", "motor_pid", "motor_pid.elf");
const PLAN = JSON.parse(
  readFileSync(path.join(repo, "examples", "hil", "motor_spinup_cosim.json"), "utf8"),
) as HilTestPlan;

function runBridge(steps: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const py = path.join(repo, "brain", ".venv", "bin", "python");
    const proc = spawn(py, ["-m", "flux_brain.sim_bridge", "--steps", String(steps)], {
      cwd: path.join(repo, "brain"),
      stdio: ["ignore", "pipe", "inherit"],
    });
    let lines = 0;
    proc.stdout.on("data", (b: Buffer) => {
      lines += b.toString().split("\n").filter((l) => l.startsWith("{")).length;
    });
    proc.on("exit", (code) => (code === 0 ? resolve(lines) : reject(new Error(`bridge exit ${code}`))));
  });
}

async function main(): Promise<void> {
  console.log("1. flash firmware into Renode…");
  const sim = new SimBackend();
  console.log("   ", (await sim.flash(ELF, "cosim-flash")).slice(0, 80) || "(loaded)");
  sim.close(); // Renode's monitor serves one telnet client — free it for the bridge

  console.log("2. lockstep bridge (Renode × Newton)…");
  const steps = await runBridge(600);
  console.log(`    ${steps} lockstep records`);

  console.log("3. HIL plan asserts on both domains…");
  const bus = new InProcessBus();
  const runner = new HilRunner(bus, async () => ({ ok: false, error: "no build here" }));
  const report = await runner.run(PLAN);
  for (const s of report.steps) {
    console.log(`    ${s.status.padEnd(5)} ${s.id}`,
      s.assertion ? `expected=${JSON.stringify(s.assertion.expected)} actual=${JSON.stringify(s.assertion.actual)}` : (s.detail.error ?? s.detail.raw ?? ""));
  }
  console.log("verdict:", report.summary.verdict);
  if (report.summary.verdict !== "PASS") { console.error("hil_cosim.smoke FAILED"); process.exit(1); }
  console.log("hil_cosim.smoke: ALL OK");
  process.exit(0);
}

main().catch((e) => { console.error("hil_cosim.smoke FAILED:", e.message); process.exit(1); });
