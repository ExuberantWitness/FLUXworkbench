// Flux Studio — preload. Bridges renderer ↔ main process.
import { contextBridge, ipcRenderer } from "electron";

interface FluxEvent {
  source: string;
  kind: string;
  topic: string;
  data: Record<string, unknown>;
  trace_id: string;
}

interface DirEntry {
  name: string;
  isDir: boolean;
  ext: string;
}

interface CondaEnv {
  name: string;
  path: string;
}

const api = {
  version: "0.2.0",
  // ── event stream ──
  onEvent(cb: (e: FluxEvent) => void): () => void {
    const handler = (_: unknown, e: FluxEvent): void => cb(e);
    ipcRenderer.on("flux:event", handler);
    return () => ipcRenderer.off("flux:event", handler);
  },
  // ── chat ──
  sendChat(text: string): Promise<void> {
    return ipcRenderer.invoke("flux:chat", text);
  },
  sendSetApi(config: Record<string, string>): Promise<void> {
    return ipcRenderer.invoke("flux:setApi", config);
  },
  fetchRepo(url: string): Promise<{ ok: boolean; path?: string; name?: string; cached?: boolean; error?: string }> {
    return ipcRenderer.invoke("flux:fetchRepo", url);
  },
  mcpTools(): Promise<Array<{ name: string; description: string; server: string }>> {
    return ipcRenderer.invoke("flux:mcpTools");
  },
  // ── file system ──
  readDir(path: string): Promise<DirEntry[]> {
    return ipcRenderer.invoke("flux:readDir", path);
  },
  readFile(path: string): Promise<string> {
    return ipcRenderer.invoke("flux:readFile", path);
  },
  writeFile(path: string, content: string): Promise<void> {
    return ipcRenderer.invoke("flux:writeFile", path, content);
  },
  createFile(path: string): Promise<void> {
    return ipcRenderer.invoke("flux:createFile", path);
  },
  createDir(path: string): Promise<void> {
    return ipcRenderer.invoke("flux:createDir", path);
  },
  deleteFile(path: string): Promise<void> {
    return ipcRenderer.invoke("flux:deleteFile", path);
  },
  renameFile(oldPath: string, newPath: string): Promise<void> {
    return ipcRenderer.invoke("flux:renameFile", oldPath, newPath);
  },
  openFolder(): Promise<string | null> {
    return ipcRenderer.invoke("flux:openFolder");
  },
  openFile(filters?: Array<{ name: string; extensions: string[] }>): Promise<string | null> {
    return ipcRenderer.invoke("flux:openFile", filters);
  },
  // ── build (cross-compile: hpm cmake | zephyr west) ──
  build(sampleDir: string, opts?: { toolchain?: "hpm" | "zephyr"; board?: string; pristine?: boolean }): Promise<{ ok: boolean; elf?: string; dts?: string; error?: string; log?: string }> {
    return ipcRenderer.invoke("flux:build", sampleDir, opts);
  },
  // ── flux assets ──
  listFluxAssets(): Promise<Array<{ id: string; ts: number; type: string; components: string[] }>> {
    return ipcRenderer.invoke("flux:listAssets");
  },
  // ── generic MCP tool call (asset flywheel entry point) ──
  mcpCall(tool: string, args: Record<string, unknown>): Promise<string> {
    return ipcRenderer.invoke("flux:mcpCall", tool, args);
  },
  // ── Golden path missions (plug in → identify → ingest → plan → verify → commit) ──
  missionStart(goal: string, opts?: { chip?: string; board?: string; backend?: string; svdPath?: string; pinmuxPath?: string }): Promise<{ missionId: string; record?: unknown; report?: unknown; planGenerated?: boolean; error?: string }> {
    return ipcRenderer.invoke("flux:missionStart", goal, opts);
  },
  missionList(): Promise<Array<Record<string, unknown>>> {
    return ipcRenderer.invoke("flux:missionList");
  },
  trajectoryStats(): Promise<{ missions: number; lines: number }> {
    return ipcRenderer.invoke("flux:trajectoryStats");
  },
  // ── evidence bundles (replayable, hash-chained HIL runs) ──
  evidenceList(): Promise<Array<{ runId: string; verdict: string; createdAt: number; content_hash: string }>> {
    return ipcRenderer.invoke("flux:evidenceList");
  },
  evidenceGet(runId: string): Promise<unknown | null> {
    return ipcRenderer.invoke("flux:evidenceGet", runId);
  },
  // ── alarm preemption demo (拔线) ──
  alarmDemo(): Promise<void> {
    return ipcRenderer.invoke("flux:alarmDemo");
  },
  alarmClear(): Promise<void> {
    return ipcRenderer.invoke("flux:alarmClear");
  },
  // ── kernel scheduler demo (内核调度演示: 真实抢占) ──
  schedulerDemo(): Promise<void> {
    return ipcRenderer.invoke("flux:schedulerDemo");
  },
  // ── 现场快照 (scene snapshot): capture / import the last N minutes ──
  sceneDump(extra?: Record<string, unknown>): Promise<{ file: string; events: number }> {
    return ipcRenderer.invoke("flux:sceneDump", extra);
  },
  sceneLoad(): Promise<Record<string, unknown> | null> {
    return ipcRenderer.invoke("flux:sceneLoad");
  },
  // ── PhysicalDevBench ──
  benchRun(taskIds?: string[], presets?: string[]): Promise<Array<Record<string, unknown>>> {
    return ipcRenderer.invoke("flux:benchRun", taskIds, presets);
  },
  benchTasks(): Promise<Array<Record<string, unknown>>> {
    return ipcRenderer.invoke("flux:benchTasks");
  },
  // ── HIL (asset-driven test plans on mock|real|sim backends) ──
  hilGenerate(goal: string, opts?: { chip?: string; board?: string; backend?: string }): Promise<{ plan: unknown; generated: boolean; error?: string }> {
    return ipcRenderer.invoke("flux:hilGenerate", goal, opts);
  },
  hilRun(plan: unknown): Promise<unknown> {
    return ipcRenderer.invoke("flux:hilRun", plan);
  },
  triage(text: string, ctx?: Record<string, unknown>): Promise<unknown> {
    return ipcRenderer.invoke("flux:triage", text, ctx);
  },
  // ── UnitPort training (kernel-scheduled subprocess) ──
  trainStart(spec: Record<string, unknown>): Promise<string> {
    return ipcRenderer.invoke("flux:trainStart", spec);
  },
  trainCancel(runId: string): Promise<boolean> {
    return ipcRenderer.invoke("flux:trainCancel", runId);
  },
  trainList(): Promise<Array<{ runId: string; startedAt: number; status: string; live: boolean; resumable: boolean; resumes: number }>> {
    return ipcRenderer.invoke("flux:trainList");
  },
  trainResume(runId: string): Promise<string | null> {
    return ipcRenderer.invoke("flux:trainResume", runId);
  },
  // ── Isaac Sim 6 ──
  gpuInfo(): Promise<{ present: boolean; name?: string; driver?: string; vram?: string; driverOk?: boolean }> {
    return ipcRenderer.invoke("flux:gpuInfo");
  },
  isaacInstall(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke("flux:isaacInstall");
  },
  isaacCancel(): Promise<boolean> {
    return ipcRenderer.invoke("flux:isaacCancel");
  },
  // ── boards / real-probe bring-up ──
  boards(): Promise<Array<Record<string, unknown>>> {
    return ipcRenderer.invoke("flux:boards");
  },
  deviceStatus(): Promise<Array<{ id: string; name: string; chip: string; vid: string; pid: string; present: boolean }>> {
    return ipcRenderer.invoke("flux:deviceStatus");
  },
  authorizeUsb(vid: string, pid: string): Promise<{ ok: boolean; error?: string; rulePath?: string }> {
    return ipcRenderer.invoke("flux:authorizeUsb", vid, pid);
  },
  probeConnect(boardId: string): Promise<{ ok: boolean; chip?: string; error?: string }> {
    return ipcRenderer.invoke("flux:probeConnect", boardId);
  },
  // ── conda ──
  condaList(): Promise<CondaEnv[]> {
    return ipcRenderer.invoke("flux:condaList");
  },
  condaCreate(name: string): Promise<void> {
    return ipcRenderer.invoke("flux:condaCreate", name);
  },
  // ── OS detection (gates Linux-only features honestly) ──
  osInfo(): Promise<{ platform: string; arch: string; distro: string; kernel: string; desktop: string; session: string; caps: { usbScan: boolean; usbAuthorize: boolean; terminal: boolean } }> {
    return ipcRenderer.invoke("flux:osInfo");
  },
  // ── bottom terminal ──
  termRun(cmd: string, cwd?: string, envBin?: string): Promise<boolean> {
    return ipcRenderer.invoke("flux:termRun", cmd, cwd, envBin);
  },
  onOpenTerminal(cb: () => void): () => void {
    const handler = (): void => cb();
    ipcRenderer.on("flux:openTerminal", handler);
    return () => ipcRenderer.off("flux:openTerminal", handler);
  },
  // ── misc ──
  status(): Promise<unknown> {
    return ipcRenderer.invoke("flux:status");
  },
  onOpenWiki(cb: (path: string) => void): () => void {
    const handler = (_: unknown, path: string): void => cb(path);
    ipcRenderer.on("flux:openWiki", handler);
    return () => ipcRenderer.off("flux:openWiki", handler);
  },
};

contextBridge.exposeInMainWorld("flux", api);

export type FluxApi = typeof api;
