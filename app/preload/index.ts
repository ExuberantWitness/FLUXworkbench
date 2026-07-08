// Flux Workbench — preload. Exposes a minimal, typed `window.flux` surface to the
// sandboxed renderer. Events from the kernel Bus are mirrored on the "flux:event"
// IPC channel; the renderer subscribes via onEvent.
import { contextBridge, ipcRenderer } from "electron";

interface FluxEvent {
  source: string;
  kind: string;
  topic: string;
  data: Record<string, unknown>;
  trace_id: string;
}

const api = {
  version: "0.1.0",
  /** Subscribe to the kernel event stream. Returns an unsubscribe fn. */
  onEvent(cb: (e: FluxEvent) => void): () => void {
    const handler = (_: unknown, e: FluxEvent): void => cb(e);
    ipcRenderer.on("flux:event", handler);
    return () => ipcRenderer.off("flux:event", handler);
  },
  status(): Promise<unknown> {
    return ipcRenderer.invoke("flux:status");
  },
  sendChat(text: string): Promise<void> {
    return ipcRenderer.invoke("flux:chat", text);
  },
};

contextBridge.exposeInMainWorld("flux", api);

export type FluxApi = typeof api;
