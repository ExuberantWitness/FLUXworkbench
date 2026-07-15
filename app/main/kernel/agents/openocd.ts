// OpenOCD embodied-agent — drives debug/flash on real or mock OpenOCD.
//
// Two modes (decision #25: physical subagent = first-class embodied agent):
//   - mock (default): spawn a line-protocol subprocess (spike/mock-openocd-cli.py)
//   - real: spawn HPMicro OpenOCD server + TCL-RPC to :6666 (drives real HPM6E00)
//
// In both modes: bus publishes cmd.flash/cmd.halt/cmd.mdw → agent executes →
// publishes openocd.event with the reply.

import { spawn, type ChildProcess } from "node:child_process";
import type { Bus } from "../bus";
import type { Event } from "../types";
import { TclRpc } from "../tcl_rpc";

const CMDS_MOCK: Record<string, (args: unknown[]) => string> = {
  "cmd.flash": (a) => `flash write_image erase ${String(a[0] ?? "")}`,
  "cmd.halt": () => "halt",
  "cmd.mdw": (a) => `mdw ${String(a[0] ?? 0)} ${Number(a[1] ?? 1)}`,
  "cmd.reg": (a) => `reg ${String(a[0] ?? "pc")}`,
  "cmd.reset": () => "reset",
};

const CMDS_REAL: Record<string, (args: unknown[]) => string> = {
  "cmd.flash": (a) => `flash write_image erase ${String(a[0] ?? "demo.elf")}`,
  "cmd.halt": () => "halt",
  "cmd.mdw": (a) => `mdw ${String(a[0] ?? 0)} ${Number(a[1] ?? 1)}`,
  "cmd.reg": (a) => `reg ${String(a[0] ?? "pc")}`,
  "cmd.reset": () => "reset run",
};

export class OpenOcdAgent {
  private proc: ChildProcess | null = null;
  private rpc: TclRpc | null = null;
  private readonly pending: Array<(reply: string) => void> = [];
  private buf = "";
  private cmds: Record<string, (args: unknown[]) => string> = CMDS_MOCK;
  private isReal = false;

  constructor(
    private readonly bus: Bus,
    private readonly name = "openocd",
  ) {}

  // ── Mock mode (line-protocol subprocess) ────────────────────────────────────
  async startMock(cliCmd: string, cliArgs: string[]): Promise<void> {
    this.cmds = CMDS_MOCK;
    this.isReal = false;
    this.proc = spawn(cliCmd, cliArgs, { stdio: ["pipe", "pipe", "pipe"] });
    const out = this.proc.stdout;
    if (!out) throw new Error("openocd mock has no stdout");
    out.setEncoding("utf8");
    out.on("data", (c: string) => this.onMockOut(c));
    this.proc.stderr?.on("data", (b: Buffer) =>
      console.warn(`[openocd:stderr] ${b.toString().trimEnd()}`));
    this.proc.on("exit", (code) => console.warn(`[openocd] exited code=${code}`));
    await this.subscribeCmds();
    await this.bus.publish(this.evt("device.attached", { device: "hpm6e00-0", chip: "HPM6E0" }));
  }

  // ── Real mode (HPM OpenOCD server + TCL RPC) ────────────────────────────────
  // Board-profile driven: cfgs[] + search path come from skills/boards.json,
  // so any board (HPM, ST-Link, …) connects through the same path.
  async startReal(
    openocdBin: string,
    cfgs: string[],
    searchPath: string,
    hpmSdkBase: string,
    chip = "device",
  ): Promise<void> {
    this.cmds = CMDS_REAL;
    this.isReal = true;
    const args: string[] = [];
    if (searchPath) args.push("-s", searchPath);
    if (hpmSdkBase) args.push("-c", `set HPM_SDK_BASE ${hpmSdkBase}`);
    for (const c of cfgs) args.push("-f", c);
    args.push("-c", "init; halt");
    // Start OpenOCD as a server (init; halt; keep running for TCL RPC)
    this.proc = spawn(openocdBin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        HPM_SDK_BASE: hpmSdkBase,
        OPENOCD_SCRIPTS: searchPath || (hpmSdkBase ? `${hpmSdkBase}/boards/openocd` : ""),
      },
    });
    this.proc.stderr?.on("data", (b: Buffer) =>
      console.warn(`[openocd:stderr] ${b.toString().trimEnd()}`));
    this.proc.on("exit", (code) => console.warn(`[openocd] exited code=${code}`));

    // Wait for OpenOCD to bind :6666 (up to 15s)
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        this.rpc = new TclRpc();
        await this.rpc.connect("127.0.0.1", 6666);
        break;
      } catch {
        // retry
      }
    }
    if (!this.rpc) throw new Error("OpenOCD TCL RPC connect timeout (:6666)");

    await this.subscribeCmds();
    await this.bus.publish(this.evt("device.attached", { device: `${chip}-0`, chip, real: true }));
  }

  private async subscribeCmds(): Promise<void> {
    for (const topic of Object.keys(this.cmds)) {
      await this.bus.subscribe(topic, (e) => void this.onCmd(e));
    }
  }

  private async onCmd(evt: Event): Promise<void> {
    const args = (evt.data?.["args"] as unknown[]) ?? [];
    const tcl = this.cmds[evt.topic]?.(args);
    if (!tcl) return;
    const reply = await this.exec(tcl);
    await this.bus.publish(
      this.evt("openocd.event", { cmd: evt.topic, tcl, reply, real: this.isReal }, evt.trace_id),
    );
  }

  private async exec(tcl: string): Promise<string> {
    if (this.isReal && this.rpc) {
      return this.rpc.cmd(tcl);
    }
    // mock: send line, wait for line reply
    return new Promise((resolve) => {
      this.pending.push(resolve);
      this.proc?.stdin?.write(tcl + "\n");
    });
  }

  // ── mock stdout handler ─────────────────────────────────────────────────────
  private onMockOut(chunk: string): void {
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

  private evt(topic: string, data: Record<string, unknown>, trace_id = ""): Event {
    return { source: this.name, kind: "execute", topic, data, trace_id };
  }

  async stop(): Promise<void> {
    this.rpc?.close();
    this.proc?.stdin?.end();
    this.proc?.kill("SIGTERM");
  }
}
