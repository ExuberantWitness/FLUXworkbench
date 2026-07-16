// Golden-path mission smoke — headless, no studio, no LLM required.
//   ./node_modules/.pnpm/node_modules/.bin/esbuild app/main/kernel/mission.smoke.ts \
//     --bundle --platform=node --external:electron --outfile=/tmp/mission-smoke.cjs \
//   && FLUX_HOME=/tmp/flux-mission-smoke node /tmp/mission-smoke.cjs
//
// Runs one full mission on the mock backend: identify → ingest(skip) →
// plan (template fallback when the LLM is absent) → verify → commit.
// Asserts: PASS verdict, mission asset committed, trajectory JSONL written,
// evidence bundle written + hash-chained.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { InProcessBus } from "./bus";
import { OpenOcdAgent } from "./agents/openocd";
import { HilRunner } from "./hil_runner";
import { MissionEngine } from "./mission";
import { GoldenPath, mcpText } from "./golden_path";
import { EventRecorder } from "./recorder";
import { writeEvidenceBundle } from "./evidence";
import { MCPOrchestrator } from "../mcp_orchestrator";

const repo = process.env["FLUX_REPO"] ?? process.cwd();
const FLUX_HOME = process.env["FLUX_HOME"] ?? "/tmp/flux-mission-smoke";
process.env["FLUX_HOME"] = FLUX_HOME;

async function main(): Promise<void> {
  const bus = new InProcessBus();
  const recorder = new EventRecorder(bus);
  await recorder.start(["hil.plan", "hil.step", "hil.report", "openocd.event",
    "asset.committed", "mission.milestone", "mcp.tool.result", "triage.result"]);

  // Brain MCP server (real flux-insight, scratch FLUX_HOME so the store is empty)
  const mcp = new MCPOrchestrator(bus);
  const brainPy = process.env["FLUX_BRAIN_PY"] ?? path.join(repo, "brain", ".venv", "bin", "python");
  await mcp.startServer({
    name: "flux-insight", command: brainPy,
    args: ["-u", path.join(repo, "brain", "flux_insight_mcp.py")],
    env: { PYTHONUNBUFFERED: "1", FLUX_HOME },
  });

  // Mock probe + HIL runner
  const ocd = new OpenOcdAgent(bus);
  await ocd.startMock("python3", [path.join(repo, "spike", "mock-openocd-cli.py")]);
  const hil = new HilRunner(bus, async () => ({ ok: true, elf: "prebuilt.elf" }));

  const missions = new MissionEngine(bus);
  const gp = new GoldenPath(bus, mcp, hil, missions,
    path.join(repo, "examples", "hil", "gpio_smoke.json"),
    async () => null, // triage stub
    (plan, report, t0) => writeEvidenceBundle(recorder, mcp, bus, plan, report, t0).then(() => void 0));

  const res = await gp.run("Verify the firmware toggles the PC13 LED", { backend: "mock" });
  console.log("mission:", res.missionId, "verdict:", res.record?.verdict,
    "planGenerated:", res.planGenerated, "ttd:", res.record?.timeToDevreadyMs, "ms");

  // ── assertions ──
  const fail = (msg: string): never => { console.error("SMOKE FAIL:", msg); process.exit(1); };
  if (res.error) fail(`golden path error: ${res.error}`);
  if (res.record?.verdict !== "PASS") fail(`verdict ${res.record?.verdict}`);

  const missionAsset = mcpText(await mcp.callTool("query_asset", { asset_id: res.missionId }, 30));
  if (!missionAsset.includes("time_to_devready_ms")) fail("mission asset missing metrics");

  const trajFile = path.join(FLUX_HOME, "trajectories", `${res.missionId}.jsonl`);
  if (!existsSync(trajFile)) fail("trajectory file missing");
  const lines = readFileSync(trajFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as { kind: string });
  const kinds = new Set(lines.map((l) => l.kind));
  if (!kinds.has("action") || !kinds.has("outcome")) fail(`trajectory kinds ${[...kinds].join(",")}`);

  const evDir = path.join(FLUX_HOME, "evidence");
  const bundles = existsSync(evDir) ? readdirSync(evDir).filter((f) => f.endsWith(".json")) : [];
  if (bundles.length === 0) fail("no evidence bundle");
  const bundle = JSON.parse(readFileSync(path.join(evDir, bundles[0]!), "utf8")) as Record<string, unknown>;
  if (!bundle["content_hash"] || !(bundle["events"] as unknown[]).length) fail("evidence bundle incomplete");
  if (!existsSync(path.join(evDir, "CHAIN"))) fail("hash chain missing");

  const eventFiles = readdirSync(path.join(FLUX_HOME, "events")).filter((f) => f.endsWith(".jsonl"));
  if (eventFiles.length === 0) fail("event recorder wrote nothing");

  // ── case 2: SVD board + board id on a FRESH store (the field failure).
  // Regression: the pinmux fallback used to fire alongside svdPath ingest
  // (board && !known), erroring "no pinmux_path given and no profile" on
  // STM32 profiles that have no pinmux field. svdPath must suppress it. ──
  const svd = path.join(process.env["HOME"] ?? "", ".flux", "svd", "STM32H743x.svd");
  if (existsSync(svd)) {
    const res2 = await gp.run("Characterize the H743 board", {
      backend: "mock", board: "nucleo-h743zi2", chip: "STM32H743ZI", svdPath: svd,
    });
    const bad = (res2.record?.milestones ?? [])
      .find((m) => (m.detail ?? "").toLowerCase().includes("pinmux"));
    if (bad) fail(`pinmux fallback fired for an SVD board: ${bad.detail}`);
    const ingested = (res2.record?.milestones ?? [])
      .some((m) => m.phase === "ingest" && m.status === "done" && (m.detail ?? "").includes("regmap-"));
    if (!ingested) fail("case2: svd ingest milestone missing");
    console.log(`case2 (svd board, fresh store): verdict ${res2.record?.verdict}, no pinmux misfire ✓`);
  } else {
    console.log("case2 skipped (no local H743 svd cache)");
  }

  console.log(`mission.smoke: ALL OK (trajectory ${lines.length} lines, evidence ${bundles.length} bundle(s), ` +
    `${eventFiles.length} event file(s))`);
  await mcp.stopAll();
  process.exit(0);
}

main().catch((e) => { console.error("SMOKE FAIL:", e); process.exit(1); });
