// OpenOCD embodied-agent (decision #25: physical subagent = first-class embodied agent).
//
// Spawns the C `flux_openocd_cli` (or a mock) as a subprocess and bridges uORB
// to its line-based TCL RPC:
//   bus publishes cmd.flash / cmd.halt / cmd.mdw → agent sends TCL → reads reply → publishes openocd.event
// This keeps OpenOCD a first-class kernel peer on the bus (stdio transport; Zenoh
// peer form deferred). v1 soft RT (no core pinning).

import { spawn, type ChildProcess } from "node:child_process";
import type { Bus } from "../bus";
import type { Event } from "../types";

type ArgList = unknown[];
const CMDS: Record<string, (args: ArgList) => string> = {
  "cmd.flash": (a) => `flash write_image erase ${String(a[0] ?? "")}`,
  "cmd.halt": () => "halt",
  "cmd.mdw": (a) => `mdw ${String(a[0] ?? 0)} ${Number(a[1] ?? 1)}`,
  "cmd.reset": () => "reset",
};

export class OpenOcdAgent {
  private proc: ChildProcess | null = null;
  private readonly pending: Array<(reply: string) => void> = [];
  private buf = "";

  constructor(
    private readonly bus: Bus,
    private readonly name = "openocd",
  ) {}

  /**
   * Spawn the OpenOCD CLI (real `flux_openocd_cli host port`, or a mock).
   * Generic (cmd, args) so dev can pass `["python3", ["mock-openocd-cli.py"]]`
   * and prod can pass `["<path>/flux_openocd_cli", ["127.0.0.1", "6666"]]`.
   */
  async start(cmd: string, args: string[] = []): Promise<void> {
    this.proc = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const out = this.proc.stdout;
    if (!out) throw new Error("openocd cli has no stdout");
    out.setEncoding("utf8");
    out.on("data", (c: string) => this.onOut(c));
    this.proc.stderr?.on("data", (b: Buffer) => {
      // eslint-disable-next-line no-console
      console.warn(`[openocd:stderr] ${b.toString().trimEnd()}`);
    });
    this.proc.on("exit", (code) => {
      // eslint-disable-next-line no-console
      console.warn(`[openocd] cli exited code=${code}`);
    });
    for (const topic of Object.keys(CMDS)) {
      await this.bus.subscribe(topic, (e) => {
        void this.onCmd(e);
      });
    }
    await this.bus.publish(this.evt("device.attached", { device: "hpm6e00-0", chip: "HPM6E0" }));
  }

  private onOut(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      const resolve = this.pending.shift();
      if (resolve) resolve(line);
    }
  }

  private async onCmd(evt: Event): Promise<void> {
    const args = (evt.data?.["args"] as ArgList) ?? [];
    const tcl = CMDS[evt.topic]?.(args);
    if (!tcl) return;
    const reply = await this.send(tcl);
    await this.bus.publish(
      this.evt("openocd.event", { cmd: evt.topic, tcl, reply }, evt.trace_id),
    );
  }

  private send(tcl: string): Promise<string> {
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.proc?.stdin?.write(tcl + "\n");
    });
  }

  private evt(
    topic: string,
    data: Record<string, unknown>,
    trace_id = "",
  ): Event {
    return { source: this.name, kind: "execute", topic, data, trace_id };
  }

  async stop(): Promise<void> {
    this.proc?.stdin?.end();
    this.proc?.kill("SIGTERM");
  }
}
