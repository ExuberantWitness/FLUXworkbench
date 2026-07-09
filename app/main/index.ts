// Flux Studio — kernel entry (Electron main process = Tier 1 base).

import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from "electron";
import * as path from "node:path";
import { existsSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { exec } from "node:child_process";
import { InProcessBus } from "./kernel/bus";
import { Scheduler } from "./kernel/scheduler";
import { Supervisor } from "./kernel/supervisor";
import { NodeIpcTransport } from "./kernel/transports/node-ipc";
import { OpenOcdAgent } from "./kernel/agents/openocd";
import { WorkflowRunner, type WorkflowDescriptor } from "./kernel/workflow_runner";
import { generateKeyPair, signManifest, verifyManifest, parseManifest } from "./kernel/capability";
import type { Event } from "./kernel/types";

// ── path resolution ──
function repoRoot(): string {
  const fromHere = path.resolve(__dirname, "..", "..", "..");
  return existsSync(path.join(fromHere, "brain"))
    ? fromHere
    : path.resolve(process.cwd(), "..");
}
const BRAIN_PY = process.env["FLUX_BRAIN_PY"] ?? path.join(repoRoot(), "brain", ".venv", "bin", "python");
const BRAIN_PATH = process.env["FLUX_BRAIN_PATH"] ?? path.join(repoRoot(), "brain");
const BRAIN_MODULE = process.env["FLUX_BRAIN_MODULE"] ?? "flux_brain.bus_ipc";
const OPENOCD_CMD = process.env["FLUX_OPENOCD_CMD"] ?? "python3";
const OPENOCD_ARGS = process.env["FLUX_OPENOCD_ARGS"]
  ? process.env["FLUX_OPENOCD_ARGS"].split(" ")
  : [path.join(repoRoot(), "spike", "mock-openocd-cli.py")];

// ── kernel singletons ──
const bus = new InProcessBus();
const scheduler = new Scheduler();
const supervisor = new Supervisor();
let mainWindow: BrowserWindow | null = null;

async function mirrorEventsToRenderer(): Promise<void> {
  const topics = [
    "brain.ready", "device.attached", "device.detached", "alarm.critical",
    "alarm.policy-violation",
    "openocd.event", "build.progress", "build.diagnostic", "asset.committed",
    "agent.event", "run.state", "workflow.published", "cmd.chat", "cmd.set_api",
  ];
  for (const t of topics) {
    await bus.subscribe(t, (e: Event) => {
      mainWindow?.webContents.send("flux:event", e);
    });
  }
}

async function bootKernel(): Promise<void> {
  await mirrorEventsToRenderer();
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

  const brainTransport = new NodeIpcTransport(bus);
  brainTransport.start(BRAIN_PY, ["-m", BRAIN_MODULE], { PYTHONPATH: BRAIN_PATH });

  const ocd = new OpenOcdAgent(bus);
  if (process.env["FLUX_OPENOCD_REAL"] === "1") {
    const ocdBin = process.env["FLUX_OPENOCD_BIN"] ?? "/tmp/hpm-openocd/src/openocd";
    const ocdCfg = process.env["FLUX_OPENOCD_CFG"]
      ?? "/home/exuber/hpm_sdk/boards/openocd/hpm6e00_all_in_one.cfg";
    const sdkBase = process.env["HPM_SDK_BASE"] ?? "/home/exuber/hpm_sdk";
    await ocd.startReal(ocdBin, ocdCfg, sdkBase)
      .then(() => console.log("[kernel] OpenOCD real mode: HPM6E00 connected"))
      .catch((e) => {
        console.error("[kernel] OpenOCD real failed, mock fallback:", e.message);
        void ocd.startMock(OPENOCD_CMD, OPENOCD_ARGS).catch(() => void 0);
      });
  } else {
    await ocd.startMock(OPENOCD_CMD, OPENOCD_ARGS).catch((e) => console.error("[openocd]", e.message));
  }

  const runner = new WorkflowRunner(bus);
  await bus.subscribe("workflow.published", (e: Event) => {
    void runner.run(e.data as unknown as WorkflowDescriptor)
      .catch((err) => console.error("[workflow]", err));
  });
  void scheduler;

  let alarmDemoed = false;
  await bus.subscribe("asset.committed", async () => {
    if (alarmDemoed) return;
    alarmDemoed = true;
    setTimeout(async () => {
      await bus.publish({
        source: "kernel", kind: "execute", topic: "alarm.critical",
        data: { source: "kernel", code: "test-alarm", message: "priority preempt demo" },
        trace_id: "alarm-demo",
      });
    }, 2000);
  });
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
      { label: "New Terminal", click: () => console.log("[menu] terminal (TODO)") },
    ]},
    { label: "Help", submenu: [
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
ipcMain.handle("flux:chat", async (_evt, text: string) => {
  await bus.publish({ source: "ui", kind: "execute", topic: "cmd.chat",
    data: { text }, trace_id: `chat-${Date.now()}` });
});
ipcMain.handle("flux:setApi", async (_evt, config: Record<string, string>) => {
  await bus.publish({ source: "ui", kind: "execute", topic: "cmd.set_api",
    data: config, trace_id: `api-${Date.now()}` });
});

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

ipcMain.handle("flux:openFolder", async () => {
  const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

ipcMain.handle("flux:condaList", async () => {
  return new Promise((resolve) => {
    exec("conda env list --json", (err, stdout) => {
      if (err) { resolve([]); return; }
      try {
        const data = JSON.parse(stdout);
        resolve((data.envs || []).map((p: string) => ({
          name: p.split("/").pop() || "base",
          path: p,
        })));
      } catch { resolve([]); }
    });
  });
});

ipcMain.handle("flux:condaCreate", async (_evt, name: string) => {
  return new Promise((resolve, reject) => {
    exec(`conda create -n ${name} -y`, (err) => err ? reject(err) : resolve(undefined));
  });
});

// ── app lifecycle ──
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
