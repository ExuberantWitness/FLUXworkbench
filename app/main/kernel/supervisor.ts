// Flux kernel — supervisor (decision #7 all-process microkernel).
//
// Spawns/monitors/restarts module processes:
//   - Python brain (single process, OpenRath-reconstructed) — TS↔brain over Node IPC
//   - OpenOCD embodied agent (C subprocess) — TS↔openocd over Zenoh
// v1 skeleton: spawn + exit logging; restart/watchdog in build-task #3 step 2.

import { spawn, type ChildProcess } from "node:child_process";

export interface ModuleSpec {
  name: string;
  cmd: string;
  args: string[];
  env?: Record<string, string>;
  /** Restart policy — "always" | "on-failure" | "never". v1: best-effort. */
  restart?: "always" | "on-failure" | "never";
}

export class Supervisor {
  private readonly procs = new Map<string, ChildProcess>();
  private readonly specs = new Map<string, ModuleSpec>();

  spawn(spec: ModuleSpec): void {
    this.specs.set(spec.name, spec);
    this.doSpawn(spec);
  }

  private doSpawn(spec: ModuleSpec): void {
    const p = spawn(spec.cmd, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.procs.set(spec.name, p);
    p.on("exit", (code, signal) => {
      // eslint-disable-next-line no-console
      console.warn(`[supervisor] ${spec.name} exited code=${code} signal=${signal}`);
      this.procs.delete(spec.name);
      // TODO(build-task #3): implement restart backoff + watchdog per spec.restart.
    });
    p.on("error", (err) => {
      // eslint-disable-next-line no-console
      console.error(`[supervisor] ${spec.name} spawn error:`, err.message);
    });
  }

  stdin(name: string): NodeJS.WritableStream | null {
    return this.procs.get(name)?.stdin ?? null;
  }

  /** Gracefully terminate all supervised processes. */
  async stopAll(): Promise<void> {
    for (const [, p] of this.procs) {
      if (!p.killed) p.kill("SIGTERM");
    }
    this.procs.clear();
  }
}
