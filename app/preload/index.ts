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
  trainList(): Promise<Array<{ runId: string; startedAt: number }>> {
    return ipcRenderer.invoke("flux:trainList");
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
  // ── conda ──
  condaList(): Promise<CondaEnv[]> {
    return ipcRenderer.invoke("flux:condaList");
  },
  condaCreate(name: string): Promise<void> {
    return ipcRenderer.invoke("flux:condaCreate", name);
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
