// Flux Studio — kernel entry (Electron main process = Tier 1 base).

import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "node:path";
import * as os from "node:os";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync, mkdirSync, unlinkSync, rmSync, renameSync } from "node:fs";
import { exec } from "node:child_process";
import { InProcessBus } from "./kernel/bus";
import { Scheduler } from "./kernel/scheduler";
import { Supervisor } from "./kernel/supervisor";
import { NodeIpcTransport } from "./kernel/transports/node-ipc";
import { MCPOrchestrator } from "./mcp_orchestrator";
import { runBuild } from "./build_service";
import { HilRunner } from "./kernel/hil_runner";
import { TrainingAgent } from "./kernel/agents/training";
import { validatePlan, type HilTestPlan } from "./kernel/hil_types";
import { EventRecorder, trajectoryStats } from "./kernel/recorder";
import { MissionEngine } from "./kernel/mission";
import { GoldenPath, commitHilReport, type GoldenPathOpts } from "./kernel/golden_path";
import { writeEvidenceBundle, listEvidence, getEvidence } from "./kernel/evidence";
import { BenchRunner } from "./kernel/bench_runner";
import { OpenOcdAgent } from "./kernel/agents/openocd";
import { WorkflowRunner, type WorkflowDescriptor } from "./kernel/workflow_runner";
import { generateKeyPair, signManifest, verifyManifest, parseManifest } from "./kernel/capability";
import type { Event } from "./kernel/types";

// ── path resolution — dev vs packaged ──
// Dev: everything lives in the repo (brain/, skills/, examples/, spike/, sim/).
// Packaged: electron-builder copies those into process.resourcesPath, and a
// relocatable CPython is shipped at resources/python (see scripts/fetch-python.mjs).
const PACKAGED = app.isPackaged;

/** Root that holds brain/skills/examples/spike/sim — repo in dev, resources when packaged. */
function assetRoot(): string {
  if (PACKAGED) return process.resourcesPath;
  const fromHere = path.resolve(__dirname, "..", "..", "..");
  return existsSync(path.join(fromHere, "brain"))
    ? fromHere
    : path.resolve(process.cwd(), "..");
}
function repoRoot(): string { return assetRoot(); }

/** The embedded python interpreter (packaged) or the repo venv (dev). */
function embeddedPython(): string {
  if (process.env["FLUX_BRAIN_PY"]) return process.env["FLUX_BRAIN_PY"]!;
  if (PACKAGED) {
    return process.platform === "win32"
      ? path.join(process.resourcesPath, "python", "python.exe")
      : path.join(process.resourcesPath, "python", "bin", "python3");
  }
  return path.join(repoRoot(), "brain", ".venv", "bin", "python");
}
const BRAIN_PY = embeddedPython();
const BRAIN_PATH = process.env["FLUX_BRAIN_PATH"] ?? path.join(repoRoot(), "brain");
const BRAIN_MODULE = process.env["FLUX_BRAIN_MODULE"] ?? "flux_brain.bus_ipc";
// mock OpenOCD runs under the embedded python too (no system python3 assumed).
const OPENOCD_CMD = process.env["FLUX_OPENOCD_CMD"] ?? BRAIN_PY;
const OPENOCD_ARGS = process.env["FLUX_OPENOCD_ARGS"]
  ? process.env["FLUX_OPENOCD_ARGS"].split(" ")
  : [path.join(repoRoot(), "spike", "mock-openocd-cli.py")];

// ── kernel singletons ──
const bus = new InProcessBus();
const scheduler = new Scheduler();
const supervisor = new Supervisor();
let mainWindow: BrowserWindow | null = null;
let mcpRef: MCPOrchestrator | null = null;
// Durable capture (P0): evidence bundles and replay read from here.
const recorder = new EventRecorder(bus);

/** Sentinel triage: error text → structured hypothesis, published as triage.result. */
async function runTriage(logText: string, source: string, context: Record<string, unknown>): Promise<unknown> {
  if (!mcpRef) return null;
  try {
    // HIL-run failures triage at the Hil band (50) — ahead of queued chat (30).
    const result = await mcpRef.callTool("triage", { log: logText, source, context }, source === "hil" ? 50 : 30);
    const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text) as Record<string, unknown>;
    await bus.publish({
      source: "sentinel", kind: "error", topic: "triage.result",
      data: parsed, trace_id: `triage-${Date.now()}`,
    });
    return parsed;
  } catch (e) {
    console.warn("[triage]", (e as Error).message);
    return null;
  }
}

const MIRROR_TOPICS = [
  "brain.ready", "device.attached", "device.detached", "alarm.critical",
  "alarm.cleared", "alarm.policy-violation",
  "openocd.event", "build.progress", "build.diagnostic", "asset.committed",
  "agent.event", "run.state", "workflow.published", "cmd.chat", "cmd.set_api",
  "hil.plan", "hil.step", "hil.report", "triage.result", "sim.state",
  "training.started", "training.progress", "training.metrics",
  "training.finished", "training.error", "training.log",
  "install.progress", "mission.milestone", "term.output",
  "scheduler.state",
];

async function mirrorEventsToRenderer(): Promise<void> {
  for (const t of MIRROR_TOPICS) {
    await bus.subscribe(t, (e: Event) => {
      mainWindow?.webContents.send("flux:event", e);
    });
  }
}

/** One-click principle: the interpreter ships INSIDE the app. This only warns
 * if the embedded runtime is somehow missing (corrupt install) — brain servers
 * would then fail to spawn, so we surface a clear reason instead of a silent hang. */
function checkEmbeddedRuntime(): void {
  if (!existsSync(BRAIN_PY)) {
    const msg = PACKAGED
      ? `Embedded Python missing at ${BRAIN_PY} — the install may be corrupt. Reinstall FluxWorkbench.`
      : `Dev venv missing at ${BRAIN_PY} — run: cd brain && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt`;
    console.error(`[kernel] ${msg}`);
    void bus.publish({ source: "kernel", kind: "error", topic: "install.progress",
      data: { line: `[ERR] ${msg}` }, trace_id: "runtime-check" });
  } else {
    console.log(`[kernel] runtime: ${BRAIN_PY}`);
  }
}

async function bootKernel(): Promise<void> {
  checkEmbeddedRuntime();
  await mirrorEventsToRenderer();
  // Durable JSONL capture: mirror list + orchestrator internals (cmd.* flow
  // through openocd.event; mcp.tool.result feeds trajectories + evidence).
  await recorder.start([...MIRROR_TOPICS, "mcp.tool.result", "mcp.notification"]);
  const { privatePem: priv, publicPem: pub } = generateKeyPair();
  const openocdManifest = parseManifest(JSON.stringify({
    identity: { name: "openocd-task", tier: "c", version: "0.1.0" },
    capabilities: {
      touchHardware: { deviceClass: "hpm6e00", interfaces: ["swd", "jtag"] },
      publishTopics: ["device.attached", "openocd.event", "alarm.critical"],
      subscribeTopics: ["cmd.flash", "cmd.halt", "cmd.mdw"],
      compute: { priority: 70, isolation: "subprocess" },
    },
    signatures: [],
  }));
  signManifest(openocdManifest, priv);
  const capOk = verifyManifest(openocdManifest, pub);
  console.log(`[kernel] capability: ${capOk ? "verified ✓" : "FAILED ✗"}`);

  // ── MCP servers (replaces Node-IPC brain) ──
  const mcp = new MCPOrchestrator(bus);

  // Start Flux-Insight MCP server (conductor + LLM)
  const brainPy = BRAIN_PY;
  const insightScript = path.join(repoRoot(), "brain", "flux_insight_mcp.py");
  await mcp.startServer({
    name: "flux-insight",
    command: brainPy,
    args: ["-u", insightScript],
    env: {
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: BRAIN_PATH,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      https_proxy: "",
      http_proxy: "",
      all_proxy: "",
    },
  }).catch((e) => console.error("[mcp] flux-insight failed:", e.message));

  // Start physical-subagent MCP server
  const physicalScript = path.join(repoRoot(), "brain", "physical_mcp.py");
  await mcp.startServer({
    name: "physical",
    command: brainPy,
    args: ["-u", physicalScript],
    env: {
      PYTHONUNBUFFERED: "1",
      PYTHONPATH: BRAIN_PATH,
      FLUX_OPENOCD_REAL: process.env["FLUX_OPENOCD_REAL"] ?? "0",
      FLUX_OPENOCD_BIN: process.env["FLUX_OPENOCD_BIN"] ?? "/tmp/hpm-openocd/src/openocd",
      HPM_SDK_BASE: process.env["HPM_SDK_BASE"] ?? "/home/exuber/hpm_sdk",
    },
  }).catch((e) => console.error("[mcp] physical failed:", e.message));

  console.log(`[mcp] ${mcp.listTools().length} tools available: ${mcp.listTools().map(t => t.name).join(", ")}`);

  // Handle chat IPC → MCP callTool
  ipcMain.handle("flux:chat", async (_evt, text: string) => {
    const result = await mcp.callTool("chat", { message: text });
    const content = (result as { content?: Array<{ text?: string }> })?.content;
    const reply = content?.[0]?.text ?? "(no reply)";
    await bus.publish({
      source: "flux-insight", kind: "execute", topic: "agent.event",
      data: { step: "chat", user: text, reply }, trace_id: `chat-${Date.now()}`,
    });
  });
  ipcMain.handle("flux:setApi", async (_evt, config: Record<string, string>) => {
    await mcp.callTool("set_api_config", config);
  });
  ipcMain.handle("flux:mcpTools", async () => mcp.listTools());

  // UnitPort MCP server (canvas→spec compile + registries) under its own 3.11 venv
  const unitportPy = process.env["FLUX_UNITPORT_PY"]
    ?? path.join(repoRoot(), "vendor", "integrations", ".venv-unitport", "bin", "python");
  if (existsSync(unitportPy)) {
    await mcp.startServer({
      name: "unitport",
      command: unitportPy,
      args: ["-u", path.join(repoRoot(), "brain", "unitport_mcp.py")],
      env: { PYTHONUNBUFFERED: "1" },
    }).catch((e) => console.error("[mcp] unitport failed:", e.message));
  }

  // Isaac Sim 6 Skills/MCP (optional): attach an installed instance's MCP server.
  // e.g. FLUX_ISAACSIM_MCP="/home/user/isaacsim6/.venv/bin/python -m isaacsim.mcp_server"
  const isaacMcp = process.env["FLUX_ISAACSIM_MCP"];
  if (isaacMcp) {
    const [cmd, ...cmdArgs] = isaacMcp.split(" ");
    await mcp.startServer({ name: "isaacsim", command: cmd!, args: cmdArgs, env: {} })
      .catch((e) => console.error("[mcp] isaacsim failed:", e.message));
  }

  // TrainingAgent: kernel-scheduled RL runs (spawn sb3_entry, tail stdout → bus)
  const training = new TrainingAgent(bus);
  ipcMain.handle("flux:trainStart", async (_evt, spec: Record<string, unknown>) => training.start(spec));
  ipcMain.handle("flux:trainCancel", async (_evt, runId: string) => training.cancel(runId));
  ipcMain.handle("flux:trainList", async () => training.list());
  ipcMain.handle("flux:trainResume", async (_evt, runId: string) => training.resume(runId));

  mcpRef = mcp;
  ipcMain.handle("flux:triage", async (_evt, logText: string, context?: Record<string, unknown>) =>
    runTriage(logText, "manual", context ?? {}));

  // ── HIL runner (asset-driven plans, mock|real|sim DeviceBackend) ──
  const hil = new HilRunner(bus, (sampleDir) => runBuild(sampleDir, bus));
  ipcMain.handle("flux:hilRun", async (_evt, plan: HilTestPlan) => {
    const t0 = Date.now();
    const report = await hil.run(plan);
    // Flywheel write-back: the report itself becomes a devready asset.
    await commitHilReport(mcp, bus, report);
    // Evidence bundle: replayable, hash-chained — the unfakeable-demo layer.
    void writeEvidenceBundle(recorder, mcp, bus, plan, report, t0);
    // Behavior-level triage: flash/build green but asserts red → why?
    if (report.summary.verdict === "FAIL") {
      const failures = report.steps
        .filter((s) => s.status !== "pass" && s.status !== "skipped")
        .map((s) => `step ${s.id} (${s.type}) ${s.status}: ${JSON.stringify(s.assertion ?? s.detail)}`)
        .join("\n");
      void runTriage(
        `HIL run ${report.runId} FAILED on ${report.board} (${report.mode}) — goal: ${report.goal}\n${failures}`,
        "hil",
        { board: report.board, plan: report.planName },
      );
    }
    return report;
  });

  // ── Mission engine + golden path (P1): plug in → identify → ingest → plan →
  // verify → commit. One mission = one point on the dashboard curve.
  const missions = new MissionEngine(bus);
  const goldenPath = new GoldenPath(bus, mcp, hil, missions,
    path.join(repoRoot(), "examples", "hil", "gpio_smoke.json"), runTriage,
    (plan, report, t0) => writeEvidenceBundle(recorder, mcp, bus, plan, report, t0).then(() => void 0));
  // Auto-resolve board + backend from what's plugged in + the goal's own words,
  // so the user just types intent — no dropdowns. Explicit opts (from tools)
  // still win. Determinism first (device present → real), natural-language
  // overrides second ("simulate"/"仿真" → sim, "mock"/"dry" → mock).
  const resolveMission = async (goal: string, opts: GoldenPathOpts): Promise<GoldenPathOpts & { why?: string }> => {
    if (opts.board && opts.backend) return opts; // fully specified — respect it
    const boards = loadBoards();
    const lsusb: string = await new Promise((res) => exec("lsusb", (_e, o) => res(o ?? "")));
    const present = boards.filter((b) => new RegExp(`ID\\s+${b["usb"]?.vid}:${b["usb"]?.pid}`, "i").test(lsusb));
    const g = goal.toLowerCase();
    // board: goal-named board wins, else the single plugged-in board, else first
    // profile. Match on digit-bearing tokens from the goal ("h743", "f103",
    // "hpm6e00") appearing anywhere in the profile id/chip/name — the previous
    // exact-id match missed "我连了h743开发板" vs id "nucleo-h743zi2".
    const hints = g.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && /\d/.test(t));
    let board = opts.board
      ? boards.find((b) => b["id"] === opts.board)
      : boards
          .map((b) => ({ b, n: hints.filter((h) => `${b["id"]} ${b["chip"]} ${b["name"]}`.toLowerCase().includes(h)).length }))
          .filter((x) => x.n > 0)
          .sort((a, z) => z.n - a.n)[0]?.b;
    if (!board) board = present[0] ?? boards[0];
    const isPresent = board ? present.some((p) => p["id"] === board!["id"]) : false;
    // `command -v` doesn't exist on Windows — use `where` there.
    const ocdProbe = process.platform === "win32" ? "where openocd" : "command -v openocd";
    const hasOpenocd = await new Promise<boolean>((r) => exec(ocdProbe, (_e, o) => r(!!(o ?? "").trim())));
    // backend: explicit words override; else real when the board is physically
    // here + openocd available; else mock.
    let backend: "mock" | "sim" | "real" = opts.backend as "mock" | "sim" | "real";
    if (!backend) {
      if (/\bsim(ulat|)|仿真|renode\b/.test(g)) backend = "sim";
      else if (/\bmock|dry|no hardware|无硬件|不接/.test(g)) backend = "mock";
      else backend = (isPresent && hasOpenocd) ? "real" : "mock";
    }
    const out: GoldenPathOpts & { why?: string } = {
      ...opts, backend,
      board: board?.["id"], chip: board?.["chip"],
    };
    const svd = board?.["svd"];
    if (typeof svd === "string" && svd.includes("/")) out.svdPath = svd;
    else if (board?.["pinmux"]) out.pinmuxPath = board["pinmux"];
    out.why = board
      ? `${board["name"]} · ${backend}${isPresent ? " (plugged in)" : ""}${backend === "real" && !hasOpenocd ? " ⚠ openocd missing" : ""}`
      : "no board profile found";
    return out;
  };
  ipcMain.handle("flux:missionStart", async (_evt, goal: string, opts?: GoldenPathOpts) => {
    const resolved = await resolveMission(goal, opts ?? {});
    const res = await goldenPath.run(goal, resolved);
    return { ...res, resolved: { board: resolved.board, backend: resolved.backend, why: resolved.why } };
  });
  ipcMain.handle("flux:missionList", async () => missions.list());
  ipcMain.handle("flux:trajectoryStats", async () => trajectoryStats());

  // Fetch a GitHub/git project into a local cache dir so PCB import (and future
  // flows) can point at it. Shallow clone; returns the local path.
  ipcMain.handle("flux:fetchRepo", async (_evt, url: string) => {
    const clean = url.trim().replace(/\.git$/, "").replace(/\/$/, "");
    if (!/^https?:\/\/|git@/.test(clean)) return { ok: false, error: "not a git URL" };
    const name = clean.split("/").pop() || "repo";
    const dest = path.join(os.homedir(), ".flux", "projects", name);
    const emit = (line: string): void => {
      void bus.publish({ source: "git", kind: "log", topic: "term.output",
        data: { line, kind: "meta" }, trace_id: "fetch-repo" });
    };
    return new Promise((resolve) => {
      if (existsSync(dest)) {
        emit(`↻ ${name} exists — pulling latest`);
        exec(`git -C ${JSON.stringify(dest)} pull --ff-only`, { timeout: 120000 }, () =>
          resolve({ ok: true, path: dest, name, cached: true }));
        return;
      }
      emit(`⬇ cloning ${clean} …`);
      mkdirSync(path.dirname(dest), { recursive: true });
      exec(`git clone --depth 1 ${JSON.stringify(clean)} ${JSON.stringify(dest)}`,
        { timeout: 180000, maxBuffer: 16 * 1024 * 1024 }, (err, _o, stderr) => {
          if (err) { emit(`✗ ${stderr.slice(-200)}`); resolve({ ok: false, error: stderr.slice(-300) || err.message }); return; }
          emit(`✓ cloned to ${dest}`);
          resolve({ ok: true, path: dest, name });
        });
    });
  });
  ipcMain.handle("flux:evidenceList", async () => listEvidence());
  ipcMain.handle("flux:evidenceGet", async (_evt, runId: string) => getEvidence(runId));

  // ── PhysicalDevBench (P4): frontier models × bare/with_assets scoreboard ──
  const bench = new BenchRunner(bus, mcp, hil, path.join(repoRoot(), "benchmarks"));
  ipcMain.handle("flux:benchRun", async (_evt, taskIds?: string[], presets?: string[]) =>
    bench.run(taskIds, presets));
  ipcMain.handle("flux:benchTasks", async () => bench.listTasks());

  // ── Alarm preemption (P5 拔线): alarm.critical freezes every queued call
  // below the Device band until the operator clears it — "硬件不等人" made visible.
  await bus.subscribe("alarm.critical", async (e: Event) => {
    mcp.pauseBelow(70);
    await bus.publish({
      source: "kernel", kind: "log", topic: "agent.event",
      data: { step: "alarm", note: `preempted: tool calls below Device(70) held (${JSON.stringify(e.data).slice(0, 120)})` },
      trace_id: e.trace_id,
    });
  });
  await bus.subscribe("alarm.cleared", async () => mcp.resume());
  ipcMain.handle("flux:alarmDemo", async () => {
    await bus.publish({
      source: "physical", kind: "error", topic: "alarm.critical",
      data: { source: "physical", code: "probe-loss", message: "debug probe disconnected (拔线 demo)" },
      trace_id: `alarm-${Date.now()}`,
    });
  });
  ipcMain.handle("flux:alarmClear", async () => {
    await bus.publish({
      source: "kernel", kind: "execute", topic: "alarm.cleared",
      data: { note: "operator resume" }, trace_id: `alarm-${Date.now()}`,
    });
  });

  // ── Scheduler demo (内核调度演示): generate real cross-band traffic against
  // the SAME priority queue callTool uses, then fire a hardware alarm mid-flight.
  // Low-priority work (agent/build/asset/background) freezes at the preemption
  // floor while Device(70) tasks jump the queue — this is what makes us not a
  // text editor: the kernel schedules by physical priority, not FIFO. Every
  // beat lands in the event JSONL, so the demo is itself replayable evidence.
  let schedulerDemoRunning = false;
  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  ipcMain.handle("flux:schedulerDemo", async () => {
    if (schedulerDemoRunning) return;
    schedulerDemoRunning = true;
    // Priority bands: Device=70, Hil=50, Agent/Build/Asset=30, Background=10.
    // Durations are chosen so each visual phase dwells long enough to be seen
    // (and screenshot-recorded) — not a canned animation, real queue occupancy.
    const bg = () => { void mcp.runDemoTask(10, "index.telemetry", 6500); void mcp.runDemoTask(10, "corpus.flush", 6500); };
    const mid = () => { void mcp.runDemoTask(50, "hil.step", 2000); void mcp.runDemoTask(30, "agent.reason", 2200); void mcp.runDemoTask(30, "build.compile", 6500); void mcp.runDemoTask(30, "asset.commit", 6500); };
    try {
      // 1. Fill the queue with low/mid-priority work: 2 fly, the rest wait.
      mid(); bg();
      await sleep(1600);
      // 2. Hardware alarm: probe-loss. Freezes everything below Device(70).
      await bus.publish({
        source: "physical", kind: "error", topic: "alarm.critical",
        data: { source: "physical", code: "probe-loss", message: "debug probe disconnected — device band preempts (内核调度演示)" },
        trace_id: `sched-${Date.now()}`,
      });
      // 3. Device-band work arrives and jumps ahead of the frozen queue.
      void mcp.runDemoTask(70, "device.attach", 3600);
      void mcp.runDemoTask(70, "rt.control-loop", 3600);
      await sleep(4400);
      // 4. Operator clears the alarm — the frozen bands resume draining.
      await bus.publish({
        source: "kernel", kind: "execute", topic: "alarm.cleared",
        data: { note: "operator resume" }, trace_id: `sched-${Date.now()}`,
      });
      await sleep(1500);
    } finally {
      schedulerDemoRunning = false;
    }
  });

  ipcMain.handle("flux:hilGenerate", async (_evt, goal: string, opts?: { chip?: string; board?: string; backend?: string }) => {
    try {
      const result = await mcp.callTool("gen_test_plan", { goal, ...(opts ?? {}) });
      const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
      const plan = JSON.parse(text) as HilTestPlan;
      const errs = validatePlan(plan);
      if (errs.length) throw new Error(`generated plan invalid: ${errs.join("; ")}`);
      return { plan, generated: true };
    } catch (e) {
      // Deterministic fallback: canned template, flagged so the UI shows "(template)".
      const tplPath = path.join(repoRoot(), "examples", "hil", "gpio_smoke.json");
      const plan = JSON.parse(readFileSync(tplPath, "utf8")) as HilTestPlan;
      return { plan, generated: false, error: (e as Error).message };
    }
  });

  // Generic MCP tool invocation from the renderer. Commit/ingest tools get their
  // asset relayed onto the bus as asset.committed so the UI flywheel lights up.
  ipcMain.handle("flux:mcpCall", async (_evt, tool: string, args: Record<string, unknown>) => {
    const result = await mcp.callTool(tool, args ?? {});
    const text = (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "";
    if (tool === "dream" || tool === "set_workspace") {
      // Both change what the asset panel should show — nudge a refresh.
      await bus.publish({
        source: "flux-insight", kind: "execute", topic: "asset.committed",
        data: { asset_id: tool, type: tool === "dream" ? "dream-report" : "workspace" },
        trace_id: `${tool}-${Date.now()}`,
      });
    }
    if (tool === "commit_asset" || tool.startsWith("ingest_") || tool === "compose_devready" || tool === "import_asset" || tool === "add_board_lesson") {
      try {
        const parsed = JSON.parse(text) as { asset_id?: string; type?: string; components?: string[] };
        if (parsed.asset_id) {
          await bus.publish({
            source: "flux-insight", kind: "execute", topic: "asset.committed",
            data: { asset_id: parsed.asset_id, type: parsed.type ?? (args?.["type"] as string) ?? "", tool },
            trace_id: `asset-${Date.now()}`,
          });
        }
      } catch { /* non-JSON tool output — no asset to relay */ }
    }
    if (tool === "delete_asset") {
      // a removal still lands on asset.committed so panels refresh their lists
      await bus.publish({
        source: "flux-insight", kind: "execute", topic: "asset.committed",
        data: { asset_id: args?.["asset_id"], type: "deleted", tool },
        trace_id: `asset-${Date.now()}`,
      });
    }
    return text;
  });

  const ocd = new OpenOcdAgent(bus);
  await ocd.startMock(OPENOCD_CMD, OPENOCD_ARGS).catch((e) => console.error("[openocd]", e.message));

  // ── Board profiles + real-probe bring-up, driven from skills/boards.json ──
  // Everything Claude Code did by hand (detect / authorize / connect) is now
  // a studio IPC — see board-bringup skill.
  const expandHome = (p: string): string => p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
  const loadBoards = (): Array<Record<string, any>> => { // eslint-disable-line @typescript-eslint/no-explicit-any
    try { return JSON.parse(readFileSync(path.join(repoRoot(), "skills", "boards.json"), "utf8")).boards ?? []; }
    catch { return []; }
  };
  ipcMain.handle("flux:boards", async () => loadBoards());

  // Detect: which board profiles match a currently-plugged debugger, and is
  // the USB node writable (else authorization is needed).
  ipcMain.handle("flux:deviceStatus", async () => {
    const lsusb: string = await new Promise((res) => exec("lsusb", (_e, o) => res(o ?? "")));
    return loadBoards().map((b) => {
      const vid = b["usb"]?.vid, pid = b["usb"]?.pid;
      const re = new RegExp(`ID\\s+${vid}:${pid}`, "i");
      const present = re.test(lsusb);
      return { id: b["id"], name: b["name"], chip: b["chip"], vid, pid, present };
    });
  });

  // Authorize: install a udev rule via pkexec (graphical password prompt), so
  // the debugger node becomes 0666 — entirely inside the studio, no terminal.
  // pkexec needs the desktop session's DISPLAY/DBUS to reach the GNOME/KDE
  // polkit agent; we pass them explicitly so it works even when the studio was
  // launched from the .desktop entry.
  ipcMain.handle("flux:authorizeUsb", async (_evt, vid: string, pid: string) => {
    if (!/^[0-9a-fA-F]{4}$/.test(vid) || !/^[0-9a-fA-F]{4}$/.test(pid)) {
      return { ok: false, error: "bad vid/pid" };
    }
    const pkexecPath = await new Promise<string>((r) => exec("command -v pkexec", (_e, o) => r((o ?? "").trim())));
    if (!pkexecPath) {
      return { ok: false, error: "pkexec not found — install policykit-1 (sudo apt install policykit-1)" };
    }
    const rule = `SUBSYSTEM=="usb", ATTRS{idVendor}=="${vid}", ATTRS{idProduct}=="${pid}", MODE="0666", TAG+="uaccess"`;
    const rulePath = `/etc/udev/rules.d/99-flux-${vid}-${pid}.rules`;
    // Also chmod any already-enumerated node so the current session works
    // without replug; udevadm trigger re-applies the rule to plugged devices.
    const script = `printf '%s\\n' '${rule}' > ${rulePath} && udevadm control --reload-rules && udevadm trigger --subsystem-match=usb`;
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    // Ensure the polkit agent is reachable from a desktop-entry launch.
    if (!env["DISPLAY"] && process.env["DISPLAY"]) env["DISPLAY"] = process.env["DISPLAY"];
    if (!env["XDG_RUNTIME_DIR"]) env["XDG_RUNTIME_DIR"] = `/run/user/${process.getuid?.() ?? 1000}`;
    return new Promise((res) => {
      exec(`pkexec bash -c ${JSON.stringify(script)}`, { env }, (err, _o, stderr) => {
        if (err) {
          const msg = (stderr || err.message).trim();
          // pkexec exit 126 = user dismissed / not authorized; 127 = agent missing.
          const friendly = /dismiss|Authentication failed|not authorized|126/.test(msg)
            ? "authorization cancelled or denied"
            : /agent|127/.test(msg) ? "no polkit agent — is a desktop session active?"
            : msg.slice(0, 200);
          res({ ok: false, error: friendly });
          return;
        }
        res({ ok: true, rulePath });
      });
    });
  });

  // Connect: start real OpenOCD for a board profile (probe → physical subagent
  // switches from mock to real). Falls back to mock on failure.
  ipcMain.handle("flux:probeConnect", async (_evt, boardId: string) => {
    const b = loadBoards().find((x) => x["id"] === boardId);
    if (!b) return { ok: false, error: `unknown board: ${boardId}` };
    const oc = b["openocd"] ?? {};
    const bin = expandHome(oc.bin ?? "openocd");
    const search = oc.search ? expandHome(oc.search) : "";
    const sdk = b["build"]?.sdk_path ? expandHome(b["build"].sdk_path) : "";
    try {
      await ocd.startReal(bin, oc.cfgs ?? [], search, sdk, b["chip"] ?? "device");
      return { ok: true, chip: b["chip"] };
    } catch (e) {
      void ocd.startMock(OPENOCD_CMD, OPENOCD_ARGS).catch(() => void 0);
      return { ok: false, error: (e as Error).message.slice(0, 200) };
    }
  });

  const runner = new WorkflowRunner(bus);
  await bus.subscribe("workflow.published", (e: Event) => {
    void runner.run(e.data as unknown as WorkflowDescriptor)
      .catch((err) => console.error("[workflow]", err));
  });
  void scheduler;

  // (The old auto-fired alarm demo is gone: alarm.critical now really preempts
  // the tool queue, so it must only fire on operator action — flux:alarmDemo.)

  // ── OS detection: the studio's Linux-specific paths (lsusb, pkexec/udev,
  // bash, conda layouts) must KNOW where they run instead of failing weirdly.
  // Detected once, cached; renderer gates buttons + shows it in the footer.
  let osInfoCache: Record<string, unknown> | null = null;
  ipcMain.handle("flux:osInfo", async () => {
    if (osInfoCache) return osInfoCache;
    const has = (cmd: string): Promise<boolean> =>
      new Promise((r) => exec(`command -v ${cmd}`, (err) => r(!err)));
    let distro = "";
    try {
      const rel = readFileSync("/etc/os-release", "utf8");
      distro = /PRETTY_NAME="?([^"\n]+)"?/.exec(rel)?.[1] ?? "";
    } catch { /* not a freedesktop Linux */ }
    const [pkexec, lsusb, udevadm] = process.platform === "linux"
      ? await Promise.all([has("pkexec"), has("lsusb"), has("udevadm")])
      : [false, false, false];
    osInfoCache = {
      platform: process.platform,           // linux | darwin | win32
      arch: process.arch,
      distro,                                // e.g. "Ubuntu 22.04.5 LTS"
      kernel: os.release(),
      desktop: process.env["XDG_CURRENT_DESKTOP"] ?? "",
      session: process.env["XDG_SESSION_TYPE"] ?? "",
      caps: {
        usbScan: lsusb,                      // device detection
        usbAuthorize: pkexec && udevadm && existsSync("/etc/udev/rules.d"),
        terminal: process.platform !== "win32",
      },
    };
    console.log(`[kernel] os: ${process.platform}/${process.arch} ${distro} · caps=${JSON.stringify(osInfoCache["caps"])}`);
    return osInfoCache;
  });

  // ── Bottom terminal (VSCode-style drawer): one-shot commands, output
  // streamed as term.output events. Not a pty — a command runner.
  ipcMain.handle("flux:termRun", async (_evt, cmd: string, cwd?: string, envBin?: string) => {
    const { spawn: spawnCmd } = require("node:child_process") as typeof import("node:child_process");
    const emit = (line: string, kind: string): void => {
      void bus.publish({ source: "terminal", kind: "log", topic: "term.output",
        data: { line, kind }, trace_id: `term-${Date.now()}` });
    };
    emit(`$ ${cmd}`, "cmd");
    const dir = cwd && existsSync(cwd) ? cwd : repoRoot();
    // Workspace conda env: prepend its bin so python/pip resolve inside it.
    const envPath = envBin && existsSync(envBin)
      ? `${envBin}:${process.env["PATH"] ?? ""}` : process.env["PATH"];
    const proc = process.platform === "win32"
      ? spawnCmd("powershell.exe", ["-NoProfile", "-Command", cmd], { cwd: dir, env: { ...process.env, PATH: envPath ?? "" } })
      : spawnCmd("bash", ["-lc", cmd], { cwd: dir, env: { ...process.env, PATH: envPath ?? "" } });
    let emitted = 0;
    const MAX_LINES = 400;
    const pump = (kind: string) => {
      let buf = "";
      return (chunk: Buffer | string): void => {
        buf += chunk.toString();
        let i: number;
        while ((i = buf.indexOf("\n")) >= 0) {
          const l = buf.slice(0, i); buf = buf.slice(i + 1);
          if (emitted === MAX_LINES) { emit(`… output truncated at ${MAX_LINES} lines`, "meta"); }
          if (emitted++ < MAX_LINES) emit(l, kind);
        }
      };
    };
    proc.stdout?.on("data", pump("out"));
    proc.stderr?.on("data", pump("err"));
    proc.on("exit", (code) => emit(`[exit ${code}]`, "meta"));
    proc.on("error", (e) => emit(`spawn error: ${e.message}`, "err"));
    return true;
  });

  // ── Dream (P6): nightly memory consolidation on the Background band.
  // First pass 10 minutes after boot, then every 24 h.
  const runDream = async (): Promise<void> => {
    try {
      await mcp.callTool("dream", {}, 10);
      await bus.publish({
        source: "dream", kind: "execute", topic: "asset.committed",
        data: { asset_id: "dream-report", type: "dream-report" },
        trace_id: `dream-${Date.now()}`,
      });
    } catch (e) { console.warn("[dream]", (e as Error).message); }
  };
  setTimeout(() => {
    void runDream();
    setInterval(() => void runDream(), 24 * 3600 * 1000);
  }, 10 * 60 * 1000);
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: "File", submenu: [
      { label: "Open Folder…", accelerator: "CmdOrCtrl+O", click: async () => {
        const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
        if (!result.canceled && result.filePaths.length > 0) {
          mainWindow?.webContents.send("flux:folderOpened", result.filePaths[0]);
        }
      }},
      { type: "separator" },
      { label: "Quit", accelerator: "CmdOrCtrl+Q", role: "quit" },
    ]},
    { label: "Edit", role: "editMenu" },
    { label: "View", submenu: [
      { label: "Toggle DevTools", accelerator: "F12", role: "toggleDevTools" },
    ]},
    { label: "Terminal", submenu: [
      { label: "New Terminal", accelerator: "Ctrl+`", click: () => {
        mainWindow?.webContents.send("flux:openTerminal");
      }},
    ]},
    { label: "Help", submenu: [
      { label: "Architecture Plan (Wiki)", click: () => {
        mainWindow?.webContents.send("flux:openWiki", "/home/exuber/CORE/CORE27/plan.md");
      }},
      { label: "Usage Guide", click: () => {
        mainWindow?.webContents.send("flux:openWiki", "/home/exuber/CORE/CORE27/FLUXworkbench/USAGE.md");
      }},
      { type: "separator" },
      { label: "About Flux Studio" },
    ]},
  ]);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900,
    autoHideMenuBar: false,
    title: "Flux Studio",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  Menu.setApplicationMenu(buildMenu());
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

// ── IPC handlers ──
ipcMain.handle("flux:status", async () => ({ ok: true, ready: true }));
// flux:chat / flux:setApi are registered in bootKernel (MCP-routed) — the old
// bus-published versions were removed to avoid double ipcMain.handle registration.

ipcMain.handle("flux:readDir", async (_evt, dirPath: string) => {
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !e.name.startsWith(".") && !e.name.startsWith("node_modules"))
      .map((e) => ({
        name: e.name,
        isDir: e.isDirectory(),
        ext: e.isFile() ? path.extname(e.name).slice(1) : "",
      }));
  } catch { return []; }
});

ipcMain.handle("flux:readFile", async (_evt, filePath: string) => {
  try { return readFileSync(filePath, "utf-8"); }
  catch { return ""; }
});

ipcMain.handle("flux:writeFile", async (_evt, filePath: string, content: string) => {
  writeFileSync(filePath, content, "utf-8");
});

ipcMain.handle("flux:createFile", async (_evt, filePath: string) => {
  writeFileSync(filePath, "", "utf-8");
});
ipcMain.handle("flux:createDir", async (_evt, dirPath: string) => {
  mkdirSync(dirPath, { recursive: true });
});
ipcMain.handle("flux:deleteFile", async (_evt, filePath: string) => {
  const stat = statSync(filePath);
  if (stat.isDirectory()) rmSync(filePath, { recursive: true });
  else unlinkSync(filePath);
});
ipcMain.handle("flux:renameFile", async (_evt, oldPath: string, newPath: string) => {
  renameSync(oldPath, newPath);
});
ipcMain.handle("flux:openFolder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});
ipcMain.handle("flux:openFile", async (_evt, filters?: Array<{ name: string; extensions: string[] }>) => {
  const result = await dialog.showOpenDialog({ properties: ["openFile"], filters });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("flux:condaList", async () => {
  // Desktop-entry launches have a clean PATH (no conda) — resolve the binary
  // from common install locations, and fall back to scanning envs/ dirs.
  const os = require("node:os") as typeof import("node:os");
  const home = os.homedir();
  const condaBins = ["conda",
    path.join(home, "miniconda3", "bin", "conda"),
    path.join(home, "anaconda3", "bin", "conda"),
    path.join(home, "miniforge3", "bin", "conda"),
    "/opt/conda/bin/conda"];
  const condaBin = condaBins.find((c) => c === "conda" ? false : existsSync(c)) ?? "conda";
  const viaCli = await new Promise<Array<{ name: string; path: string }>>((resolve) => {
    exec(`${condaBin} env list --json`, (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const data = JSON.parse(stdout);
        resolve((data.envs || []).map((p: string) => ({ name: p.split("/").pop() || "base", path: p })));
      } catch { resolve([]); }
    });
  });
  if (viaCli.length) return viaCli;
  // No conda CLI reachable — enumerate env directories directly.
  const found: Array<{ name: string; path: string }> = [];
  for (const root of ["miniconda3", "anaconda3", "miniforge3"].map((d) => path.join(home, d))) {
    if (!existsSync(root)) continue;
    found.push({ name: "base", path: root });
    const envs = path.join(root, "envs");
    if (existsSync(envs)) {
      for (const e of readdirSync(envs)) found.push({ name: e, path: path.join(envs, e) });
    }
  }
  return found;
});

ipcMain.handle("flux:listAssets", async () => {
  const { exec } = require("child_process");
  return new Promise((resolve) => {
    const py = BRAIN_PY;
    exec(`${py} -c "from flux_brain import asset_store;import json;print(json.dumps(asset_store.list_assets()))"`,
      { env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHONPATH: process.env["FLUX_BRAIN_PATH"] ?? path.join(repoRoot(), "brain") } },
      (err: Error | null, stdout: string) => { try { resolve(JSON.parse(stdout.trim())); } catch { resolve([]); } });
  });
});

ipcMain.handle("flux:condaCreate", async (_evt, name: string) => {
  return new Promise((resolve, reject) => {
    exec(`conda create -n ${name} -y`, (err) => err ? reject(err) : resolve(undefined));
  });
});

// ── app lifecycle ──
// ── GPU detection + Isaac Sim 6 one-click install ──
ipcMain.handle("flux:gpuInfo", async () => {
  return new Promise((resolve) => {
    exec("nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader",
      (err, stdout) => {
        if (err || !stdout.trim()) { resolve({ present: false }); return; }
        const [name, driver, vram] = stdout.trim().split("\n")[0]!.split(",").map((s) => s.trim());
        resolve({ present: true, name, driver, vram, driverOk: parseInt(driver ?? "0", 10) >= 580 });
      });
  });
});

let isaacInstallProc: import("node:child_process").ChildProcess | null = null;
ipcMain.handle("flux:isaacInstall", async () => {
  if (isaacInstallProc) return { ok: false, error: "install already running" };
  const { spawn: spawnProc } = require("node:child_process") as typeof import("node:child_process");
  const script = path.join(repoRoot(), "scripts", "install_isaacsim6.sh");
  const proc = spawnProc("bash", [script], { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
  isaacInstallProc = proc;
  const emit = (line: string): void => {
    void bus.publish({ source: "isaac-installer", kind: "execute", topic: "install.progress",
      data: { line }, trace_id: "isaac6" });
  };
  let buf = "";
  proc.stdout.setEncoding("utf8");
  proc.stdout.on("data", (c: string) => {
    buf += c;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) emit(l); }
  });
  proc.stderr.on("data", (b: Buffer) => emit(`[ERR] ${b.toString().trim().slice(0, 200)}`));
  proc.on("exit", (code) => { isaacInstallProc = null; emit(`[EXIT] code=${code}`); });
  return { ok: true };
});
ipcMain.handle("flux:isaacCancel", async () => {
  isaacInstallProc?.kill("SIGTERM");
  return isaacInstallProc !== null;
});

ipcMain.handle("flux:build", async (_evt: any, sampleDir: string, opts?: { toolchain?: "hpm" | "zephyr"; board?: string; pristine?: boolean }) => {
  // devready build_howto paths use ~ — expand before hitting the filesystem
  if (sampleDir.startsWith("~")) sampleDir = path.join(os.homedir(), sampleDir.slice(1));
  const result = await runBuild(sampleDir, bus, opts ?? {});
  if (!result.ok) {
    void runTriage(result.log ?? result.error ?? "", "build", { sampleDir, board: opts?.board });
  } else if (result.dts && mcpRef) {
    // Build-time flywheel: every zephyr build auto-ingests its flattened devicetree.
    void mcpRef.callTool("ingest_dts", { dts_path: result.dts, board: result.board ?? "" }, 10)
      .then((r) => {
        const text = (r as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? "{}";
        const parsed = JSON.parse(text) as { asset_id?: string };
        if (parsed.asset_id) {
          void bus.publish({
            source: "build-service", kind: "execute", topic: "asset.committed",
            data: { asset_id: parsed.asset_id, type: "devicetree" }, trace_id: `dts-${Date.now()}`,
          });
        }
      })
      .catch((e) => console.warn("[build] dts ingest failed:", (e as Error).message));
  }
  return result;
});

// ── auto-update (GitHub Releases via electron-updater) ──
// Only AppImage self-updates on Linux; deb installs update through apt/dpkg.
function setupAutoUpdate(): void {
  if (!app.isPackaged) return;
  if (process.platform === "linux" && !process.env["APPIMAGE"]) return;
  autoUpdater.on("error", (e) => console.warn("[update]", e.message));
  autoUpdater.on("update-available", (info) =>
    console.log(`[update] v${info.version} available — downloading in background`));
  autoUpdater.on("update-downloaded", (info) =>
    console.log(`[update] v${info.version} downloaded — will install on quit`));
  void autoUpdater.checkForUpdatesAndNotify();
}

app.whenReady().then(async () => {
  await bootKernel().catch((e) => console.error("[kernel] boot failed:", e));
  await createWindow();
  setupAutoUpdate();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", async () => {
  await supervisor.stopAll();
  // MCP servers are cleaned up by supervisor or OS; add explicit cleanup if needed
  if (process.platform !== "darwin") app.quit();
});
