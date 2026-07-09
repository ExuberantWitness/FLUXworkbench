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
  openFolder(): Promise<string | null> {
    return ipcRenderer.invoke("flux:openFolder");
  },
  // ── build (cross-compile) ──
  build(sampleDir: string): Promise<{ ok: boolean; elf?: string; error?: string; log?: string }> {
    return ipcRenderer.invoke("flux:build", sampleDir);
  },
  // ── flux assets ──
  listFluxAssets(): Promise<Array<{ id: string; path: string; kind: string; records: number }>> {
    return ipcRenderer.invoke("flux:listAssets");
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
};

contextBridge.exposeInMainWorld("flux", api);

export type FluxApi = typeof api;
