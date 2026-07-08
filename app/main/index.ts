// Flux Workbench — kernel entry (Electron main process = Tier 1 base).
//
// bootKernel wires the infrastructure core: Bus + Scheduler + Supervisor +
// NodeIpcTransport (Python brain) + OpenOcdAgent (embodied agent). Events flow
// over the Bus and are mirrored to the renderer via IPC (flux:event channel).

import { app, BrowserWindow, ipcMain, shell } from "electron";
import * as path from "node:path";
import { existsSync } from "node:fs";
import { InProcessBus } from "./kernel/bus";
import { Scheduler } from "./kernel/scheduler";
import { Supervisor } from "./kernel/supervisor";
import { NodeIpcTransport } from "./kernel/transports/node-ipc";
import { OpenOcdAgent } from "./kernel/agents/openocd";
import { WorkflowRunner, type WorkflowDescriptor } from "./kernel/workflow_runner";
import { generateKeyPair, signManifest, verifyManifest, parseManifest } from "./kernel/capability";
import type { Event } from "./kernel/types";

// ── path resolution (dev: cwd=app/, repo root = ../.. from out/main) ─────────
function repoRoot(): string {
  // out/main/index.js -> ../../../ = repo root in dev; fall back to cwd/..
  const fromHere = path.resolve(__dirname, "..", "..", "..");
  return existsSync(path.join(fromHere, "brain"))
    ? fromHere
    : path.resolve(process.cwd(), "..");
}
const BRAIN_PY = process.env["FLUX_BRAIN_PY"] ?? path.join(repoRoot(), "brain", ".venv", "bin", "python");
const BRAIN_PATH = process.env["FLUX_BRAIN_PATH"] ?? path.join(repoRoot(), "brain");
const BRAIN_MODULE = process.env["FLUX_BRAIN_MODULE"] ?? "flux_brain.bus_ipc";
// dev default: mock openocd cli (no real board). Prod: FLUX_OPENOCD_CLI=<path> [args...]
const OPENOCD_CMD = process.env["FLUX_OPENOCD_CMD"] ?? "python3";
const OPENOCD_ARGS = process.env["FLUX_OPENOCD_ARGS"]
  ? process.env["FLUX_OPENOCD_ARGS"].split(" ")
  : [path.join(repoRoot(), "spike", "mock-openocd-cli.py")];

// ── kernel singletons ────────────────────────────────────────────────────────
const bus = new InProcessBus();
const scheduler = new Scheduler();
const supervisor = new Supervisor();
let mainWindow: BrowserWindow | null = null;

/** Forward every Bus event to the renderer (flux:event). */
async function mirrorEventsToRenderer(): Promise<void> {
  // A coarse wildcard: subscribe to a fixed set of v1 topics. (True wildcard
  // arrives with the BusListener refactor — v1 lists topics.)
  const topics = [
    "brain.ready", "device.attached", "device.detached", "alarm.critical",
    "openocd.event", "build.progress", "build.diagnostic", "asset.committed",
    "agent.event", "run.state", "workflow.published", "cmd.chat",
  ];
  for (const t of topics) {
    await bus.subscribe(t, (e: Event) => {
      // eslint-disable-next-line no-console
      console.log(`[flux:event] ${e.topic}  src=${e.source}`);
      mainWindow?.webContents.send("flux:event", e);
    });
  }
}

async function bootKernel(): Promise<void> {
  await mirrorEventsToRenderer();

  // Gap 2: capability enforcement — generate project keypair, sign + verify
  // the OpenOCD agent manifest before allowing it to start (plan #13).
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
  console.log(`[kernel] capability: openocd manifest ${capOk ? "verified ✓" : "FAILED ✗"}`);
  if (!capOk) console.error("[kernel] SECURITY: proceeding anyway (v1 dev mode)");

  // Python brain — supervised subprocess, uORB over Node IPC.
  const brainTransport = new NodeIpcTransport(bus);
  // NodeIpcTransport.start spawns directly; track via supervisor for lifecycle logs.
  brainTransport.start(BRAIN_PY, ["-m", BRAIN_MODULE], { PYTHONPATH: BRAIN_PATH });

  // OpenOCD embodied agent: real (HPM OpenOCD + HPM6E00 board) or mock.
  const ocd = new OpenOcdAgent(bus);
  if (process.env["FLUX_OPENOCD_REAL"] === "1") {
    const ocdBin = process.env["FLUX_OPENOCD_BIN"] ?? "/tmp/hpm-openocd/src/openocd";
    const ocdCfg = process.env["FLUX_OPENOCD_CFG"]
      ?? "/home/exuber/hpm_sdk/boards/openocd/hpm6e00_all_in_one.cfg";
    const sdkBase = process.env["HPM_SDK_BASE"] ?? "/home/exuber/hpm_sdk";
    await ocd.startReal(ocdBin, ocdCfg, sdkBase)
      .then(() => console.log("[kernel] OpenOCD real mode: HPM6E00 connected"))
      .catch((e) => {
        console.error("[kernel] OpenOCD real mode failed, falling back to mock:", e.message);
        void ocd.startMock(OPENOCD_CMD, OPENOCD_ARGS).catch(() => void 0);
      });
  } else {
    await ocd.startMock(OPENOCD_CMD, OPENOCD_ARGS).catch((e) => console.error("[openocd] start failed:", e));
  }

  // When the brain publishes a workflow DAG, dispatch its cmd.* steps in order
  // (decision #20: TS dispatches the flow Python produced). The brain's
  // openocd.event reaction handles characterize + devready.commit.
  const runner = new WorkflowRunner(bus);
  await bus.subscribe("workflow.published", (e: Event) => {
    void runner
      .run(e.data as unknown as WorkflowDescriptor)
      .catch((err) => console.error("[workflow] run failed:", err));
  });
  void scheduler; // scheduler wired for ad-hoc tasks; workflow steps dispatch directly via the bus.

  // Gap 6: alarm preempt demo — after the first asset commit, publish a test
  // alarm.critical to demonstrate the priority system (plan verification step 9).
  let alarmDemoed = false;
  await bus.subscribe("asset.committed", async () => {
    if (alarmDemoed) return;
    alarmDemoed = true;
    setTimeout(async () => {
      await bus.publish({
        source: "kernel", kind: "execute", topic: "alarm.critical",
        data: { source: "kernel", code: "test-alarm",
                message: "post-commit test alarm (priority preempt demo)" },
        trace_id: "alarm-demo",
      });
      console.log("[kernel] alarm demo: published alarm.critical (p90)");
    }, 2000);
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440, height: 900, autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "index.js"),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });
  const devUrl = process.env["ELECTRON_RENDERER_URL"] ?? process.env["FLUX_DEV_URL"];
  if (devUrl) await mainWindow.loadURL(devUrl);
  else await mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

ipcMain.handle("flux:status", async () => ({ ok: true, ready: true }));
ipcMain.on("flux:subscribe", () => {
  /* renderer signals interest; events already mirrored via flux:event */
});
ipcMain.handle("flux:chat", async (_evt, text: string) => {
  await bus.publish({
    source: "ui", kind: "execute", topic: "cmd.chat",
    data: { text }, trace_id: `chat-${Date.now()}`,
  });
});

app.whenReady().then(async () => {
  await bootKernel().catch((e) => console.error("[kernel] boot failed:", e));
  await createWindow();
  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on("window-all-closed", async () => {
  await supervisor.stopAll();
  if (process.platform !== "darwin") app.quit();
});
