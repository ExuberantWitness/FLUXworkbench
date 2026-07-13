// DeviceBackend — the HIL runner's three execution targets behind one interface.
//
//   mock  → bus cmd.* to OpenOcdAgent (stateful spike/mock-openocd-cli.py)
//   real  → bus cmd.* to OpenOcdAgent (TCL-RPC to real OpenOCD :6666)
//   sim   → Renode monitor (phase 5a) — same probe reply shapes, same parser
//
// mock/real share BusBackend: correlation is by trace_id, which OpenOcdAgent
// echoes back on openocd.event untouched.

import type { Bus } from "./bus";
import type { Event } from "./types";
import type { HilBackendKind } from "./hil_types";

export interface ProbeRequest {
  op: "read_reg" | "read_mem";
  reg?: string;
  addr?: string;
  count?: number;
}

export interface DeviceBackend {
  readonly kind: HilBackendKind;
  flash(elf: string, traceId: string): Promise<string>;
  reset(run: boolean, traceId: string): Promise<string>;
  probe(req: ProbeRequest, traceId: string): Promise<string>;
  /** Release exclusive resources (Renode's telnet monitor serves one client). */
  close?(): void;
}

const STEP_TIMEOUT_MS = 15_000;

/** mock + real: publish cmd.* and await the trace-matched openocd.event. */
export class BusBackend implements DeviceBackend {
  constructor(
    private readonly bus: Bus,
    public readonly kind: "mock" | "real",
  ) {}

  private exec(topic: string, args: unknown[], traceId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        void unsub.then((u) => u());
        reject(new Error(`${topic} timeout (${STEP_TIMEOUT_MS / 1000}s) trace=${traceId}`));
      }, STEP_TIMEOUT_MS);
      const unsub = this.bus.subscribe("openocd.event", (e: Event) => {
        if (e.trace_id !== traceId) return;
        clearTimeout(timer);
        void unsub.then((u) => u());
        resolve(String(e.data?.["reply"] ?? ""));
      });
      void unsub.then(() =>
        this.bus.publish({
          source: "hil-runner", kind: "execute", topic,
          data: { args }, trace_id: traceId,
        }),
      );
    });
  }

  flash(elf: string, traceId: string): Promise<string> {
    return this.exec("cmd.flash", [elf], traceId);
  }

  reset(run: boolean, traceId: string): Promise<string> {
    return this.exec("cmd.reset", [run ? "run" : "halt"], traceId);
  }

  probe(req: ProbeRequest, traceId: string): Promise<string> {
    if (req.op === "read_reg") {
      return this.exec("cmd.reg", [req.reg ?? "pc"], traceId);
    }
    return this.exec("cmd.mdw", [req.addr ?? "0x0", req.count ?? 1], traceId);
  }
}

/** sim: Renode telnet monitor (phase 5a). Connects to a running headless Renode
 *  (`renode --disable-gui --port <port> <generated.resc>`); replies are
 *  normalized into OpenOCD mdw shape so the probe parser is shared. */
export class SimBackend implements DeviceBackend {
  readonly kind = "sim" as const;
  private sock: import("node:net").Socket | null = null;
  private buf = "";
  private queue: Array<{ resolve: (s: string) => void }> = [];

  constructor(
    private readonly host = process.env["FLUX_RENODE_HOST"] ?? "127.0.0.1",
    private readonly port = Number(process.env["FLUX_RENODE_PORT"] ?? 3456),
  ) {}

  private async connect(): Promise<void> {
    if (this.sock) return;
    const net = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: this.host, port: this.port }, () => {
        this.sock = sock;
        // The monitor stays silent for late-joining clients — poke it so the
        // prompt comes back and resolves the connect waiter.
        sock.write("\n");
      });
      sock.setEncoding("utf8");
      sock.on("data", (chunk: string) => this.onData(chunk));
      sock.on("error", (e) => { this.sock = null; reject(e); });
      sock.on("close", () => { this.sock = null; });
      this.queue.push({ resolve: () => resolve() });
      setTimeout(() => reject(new Error(`renode monitor connect timeout ${this.host}:${this.port}`)), 8000);
    });
  }

  /** Strip ANSI colors, then telnet negotiation garbage / control bytes. */
  private static clean(s: string): string {
    return s
      .replace(/\x1b\[[0-9;]*m/g, "")
      .replace(/[^\x20-\x7e\r\n]/g, "");
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    const clean = SimBackend.clean(this.buf);
    // A command's output is complete when the "(machine)" prompt returns.
    if (this.queue.length > 0 && /\(\S+\)\s*$/.test(clean)) {
      this.buf = "";
      const head = this.queue.shift()!;
      head.resolve(clean);
    }
  }

  private async cmd(command: string): Promise<string> {
    await this.connect();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`renode cmd timeout: ${command}`)), STEP_TIMEOUT_MS);
      this.queue.push({
        resolve: (clean) => {
          clearTimeout(timer);
          // Drop the echoed command and the trailing prompt; keep the payload.
          const payload = clean
            .split(command).join("")
            .replace(/\(\S+\)\s*$/, "")
            .trim();
          resolve(payload);
        },
      });
      this.sock!.write(command + "\n");
    });
  }

  async flash(elf: string): Promise<string> {
    await this.cmd("pause").catch(() => "");
    const r = await this.cmd(`sysbus LoadELF @${elf}`);
    if (/error|failed|does not exist/i.test(r)) throw new Error(`LoadELF: ${r.slice(0, 200)}`);
    // Cortex-M: Renode doesn't fetch SP/PC for late-loaded ELFs — read them from
    // the vector table in the loaded image and set the CPU explicitly.
    const vbase = parseInt(process.env["FLUX_SIM_VECTOR_BASE"] ?? "0x08000000", 16);
    const sp = (await this.cmd(`sysbus ReadDoubleWord 0x${vbase.toString(16)}`)).match(/0x[0-9a-fA-F]+/)?.[0];
    const pc = (await this.cmd(`sysbus ReadDoubleWord 0x${(vbase + 4).toString(16)}`)).match(/0x[0-9a-fA-F]+/)?.[0];
    if (sp && pc && parseInt(sp, 16) !== 0) {
      await this.cmd(`sysbus.cpu SP ${sp}`);
      await this.cmd(`sysbus.cpu PC ${pc}`);
    }
    await this.cmd("start");
    return `loaded ${elf}; SP=${sp} PC=${pc}; emulation started`;
  }

  async reset(run: boolean): Promise<string> {
    const r = await this.cmd("machine Reset");
    if (run) await this.cmd("start");
    return r || `reset (${run ? "run" : "halt"}) complete`;
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  async probe(req: ProbeRequest): Promise<string> {
    if (req.op === "read_reg") {
      const out = await this.cmd(`cpu ${String(req.reg ?? "PC").toUpperCase()}`);
      return `${req.reg} (/32): ${out.match(/0x[0-9a-fA-F]+/)?.[0] ?? out}`;
    }
    const base = parseInt(req.addr ?? "0x0", 16);
    const count = req.count ?? 1;
    const words: string[] = [];
    for (let i = 0; i < count; i++) {
      const out = await this.cmd(`sysbus ReadDoubleWord 0x${(base + 4 * i).toString(16)}`);
      const hex = out.match(/0x([0-9a-fA-F]+)/)?.[1] ?? "0";
      words.push(hex.padStart(8, "0"));
    }
    // OpenOCD mdw shape → same parser as mock/real
    return `0x${base.toString(16).padStart(8, "0")}: ${words.join(" ")}`;
  }
}

export function makeBackend(kind: HilBackendKind, bus: Bus): DeviceBackend {
  if (kind === "sim") return new SimBackend();
  return new BusBackend(bus, kind);
}
