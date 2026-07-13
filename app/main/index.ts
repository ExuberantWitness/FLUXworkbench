// Flux Studio — kernel entry (Electron main process = Tier 1 base).

import { app, BrowserWindow, ipcMain, shell, Menu, dialog } from "electron";
import { autoUpdater } from "electron-updater";
import * as path from "node:path";
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
let mcpRef: MCPOrchestrator | null = null;

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

async function mirrorEventsToRenderer(): Promise<void> {
  const topics = [
    "brain.ready", "device.attached", "device.detached", "alarm.critical",
    "alarm.policy-violation",
    "openocd.event", "build.progress", "build.diagnostic", "asset.committed",
    "agent.event", "run.state", "workflow.published", "cmd.chat", "cmd.set_api",
    "hil.plan", "hil.step", "hil.report", "triage.result", "sim.state",
    "training.started", "training.progress", "training.metrics",
    "training.finished", "training.error", "training.log",
    "install.progress",
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

  // ── MCP servers (replaces Node-IPC brain) ──
  const mcp = new MCPOrchestrator(bus);

  // Start Flux-Insight MCP server (conductor + LLM)
  const brainPy = process.env["FLUX_BRAIN_PY"] ?? path.join(repoRoot(), "brain", ".venv", "bin", "python");
  const insightScript = path.join(repoRoot(), "brain", "flux_insight_mcp.py");
  await mcp.startServer({
    name: "flux-insight",
    command: brainPy,
    args: ["-u", insightScript],
    env: {
      PYTHONUNBUFFERED: "1",
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

  mcpRef = mcp;
  ipcMain.handle("flux:triage", async (_evt, logText: string, context?: Record<string, unknown>) =>
    runTriage(logText, "manual", context ?? {}));

  // ── HIL runner (asset-driven plans, mock|real|sim DeviceBackend) ──
  const hil = new HilRunner(bus, (sampleDir) => runBuild(sampleDir, bus));
  ipcMain.handle("flux:hilRun", async (_evt, plan: HilTestPlan) => {
    const report = await hil.run(plan);
    // Flywheel write-back: the report itself becomes a devready asset.
    try {
      const text = await mcp.callTool("commit_asset", {
        // background band: report write-back never blocks interactive calls
        asset_id: `hilreport-${report.runId}`,
        type: "hil-report",
        source: { kind: "hil-run", board: report.board, mode: report.mode },
        components: [report.board, report.planName],
        characterization: { summary: report.summary, goal: report.goal, steps: report.steps },
      }, 10);
      void text;
      await bus.publish({
        source: "hil-runner", kind: "execute", topic: "asset.committed",
        data: { asset_id: `hilreport-${report.runId}`, type: "hil-report" },
        trace_id: report.runId,
      });
    } catch (e) {
      console.warn("[hil] report asset commit failed:", (e as Error).message);
    }
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
    if (tool === "commit_asset" || tool.startsWith("ingest_")) {
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
    return text;
  });

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

ipcMain.handle("flux:listAssets", async () => {
  const { exec } = require("child_process");
  return new Promise((resolve) => {
    const py = process.env["FLUX_BRAIN_PY"] ?? path.join(repoRoot(), "brain", ".venv", "bin", "python");
    exec(`${py} -c "from flux_brain import asset_store;import json;print(json.dumps(asset_store.list_assets()))"`,
      { env: { ...process.env, PYTHONPATH: process.env["FLUX_BRAIN_PATH"] ?? path.join(repoRoot(), "brain") } },
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
