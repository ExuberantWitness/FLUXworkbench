// Node IPC transport — uORB over newline-JSON stdio to a supervised subprocess
// (the Python brain). Implements the same symmetric wire protocol as
// brain/flux_brain/bus_ipc.py (ADR 0002 hybrid bus: TS↔Python over Node IPC).
//
// Frames (one JSON object per line):
//   {"t":"pub",  "topic":.., "source":.., "kind":.., "data":{..}, "trace_id":..}
//   {"t":"sub",  "topic":..}
//   {"t":"unsub","topic":..}
//   {"t":"cmd",  "target":.., "op":.., "args":[..], "kwargs":{..}, "trace_id":..}

import { spawn, type ChildProcess } from "node:child_process";
import type { Bus } from "../bus";
import type { Event, EventKind } from "../types";

export interface Frame {
  t: "pub" | "sub" | "unsub" | "cmd";
  topic?: string;
  target?: string;
  op?: string;
  args?: unknown[];
  kwargs?: Record<string, unknown>;
  source?: string;
  kind?: string;
  data?: Record<string, unknown>;
  trace_id?: string;
}

/**
 * Bridges the kernel's in-process {@link Bus} to a supervised Python subprocess.
 * Local Bus publishes → forwarded to child as `pub` frame.
 * Child `pub` frame → republished on local Bus.
 * Subscriptions propagate both ways so each side only forwards what the other wants.
 */
export class NodeIpcTransport {
  private proc: ChildProcess | null = null;
  private buf = "";
  private readonly remoteSubs = new Set<string>();
  private readonly localUnsubs = new Map<string, () => void>();

  constructor(private readonly bus: Bus) {}

  start(cmd: string, args: string[], env: Record<string, string> = {}): void {
    this.proc = spawn(cmd, args, { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    const out = this.proc.stdout;
    if (!out) throw new Error("child has no stdout");
    out.setEncoding("utf8");
    out.on("data", (chunk: string) => this.onChunk(chunk));
    this.proc.stderr?.on("data", (b: Buffer) => {
      // eslint-disable-next-line no-console
      console.warn(`[brain:stderr] ${b.toString().trimEnd()}`);
    });
    this.proc.on("exit", (code) => {
      // eslint-disable-next-line no-console
      console.warn(`[node-ipc] child exited code=${code}`);
    });
  }

  /**
   * Wire the Bus↔Transport bridge: when the child subscribes to a topic (via a
   * `sub` frame), subscribe to that topic on the local Bus and forward every
   * published Event to the child as a `pub` frame. This is the seam verified in
   * the vertical dry-run (spike/vertical-dryrun.mjs).
   */
  private async bridgeSub(topic: string): Promise<void> {
    const unsub = await this.bus.subscribe(topic, (e) =>
      this.write({ t: "pub", topic: e.topic, source: e.source, kind: e.kind,
        data: e.data, trace_id: e.trace_id }),
    );
    this.localUnsubs.set(topic, unsub);
  }

  /** Forward a local Event to the child (if it subscribed the topic; v1 forward-all). */
  forward(evt: Event): void {
    void this.remoteSubs; // v1 forward-all (subs tracked but not gating yet)
    this.write({ t: "pub", topic: evt.topic, source: evt.source, kind: evt.kind,
      data: evt.data, trace_id: evt.trace_id });
  }

  /** Subscribe to a topic on the child (child will forward its pubs of it). */
  subscribe(topic: string): void {
    this.write({ t: "sub", topic });
  }

  /** Send a command Message to the child. */
  sendCmd(target: string, op: string, args: unknown[] = [], traceId = ""): void {
    this.write({ t: "cmd", target, op, args, trace_id: traceId });
  }

  get stdin(): NodeJS.WritableStream | null {
    return this.proc?.stdin ?? null;
  }

  async stop(): Promise<void> {
    this.proc?.stdin?.end();
    this.proc?.kill("SIGTERM");
    this.localUnsubs.forEach((u) => u());
    this.localUnsubs.clear();
  }

  private write(f: Frame): void {
    this.proc?.stdin?.write(JSON.stringify(f) + "\n");
  }

  private onChunk(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onFrame(line).catch(() => void 0);
    }
  }

  private async onFrame(line: string): Promise<void> {
    let f: Frame;
    try {
      f = JSON.parse(line) as Frame;
    } catch {
      return;
    }
    switch (f.t) {
      case "pub":
        await this.bus.publish({
          source: f.source ?? "?", kind: (f.kind as EventKind) ?? "log",
          topic: f.topic ?? "?", data: f.data ?? {}, trace_id: f.trace_id ?? "",
        });
        break;
      case "sub":
        if (f.topic) {
          this.remoteSubs.add(f.topic);
          await this.bridgeSub(f.topic);
        }
        break;
      case "unsub":
        if (f.topic) {
          this.remoteSubs.delete(f.topic);
          this.localUnsubs.get(f.topic)?.();
          this.localUnsubs.delete(f.topic);
        }
        break;
      case "cmd":
        // Commands from brain are rare; route via Bus.send if a router is registered.
        await this.bus.send({ target: f.target ?? "", op: f.op ?? "",
          args: f.args, trace_id: f.trace_id ?? "" });
        break;
    }
  }
}
