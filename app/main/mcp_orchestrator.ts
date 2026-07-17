// MCP Orchestrator — manages MCP server lifecycles + routes tool calls.
//
// Each MCP server = a child process speaking JSON-RPC 2.0 over stdio.
// The orchestrator:
//   1. Starts/stops MCP servers (spawn subprocess)
//   2. Lists available tools (aggregated from all servers)
//   3. Routes tool calls to the right server
//   4. Bridges tool results to the uORB bus (events flow to UI)
//
// Protocol: MCP 2025-11-25 (tools/list, tools/call, resources/*)

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { InProcessBus } from "./kernel/bus";
import { Priority, type Event } from "./kernel/types";

interface MCPTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  server: string; // which MCP server owns this tool
}

interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  priority?: number; // for scheduler integration
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

export class MCPOrchestrator {
  private servers = new Map<string, ChildProcess>();
  private tools: MCPTool[] = [];
  private pending = new Map<string, PendingRequest>();
  private buffers = new Map<string, string>();
  private bus: InProcessBus;

  constructor(bus: InProcessBus) {
    this.bus = bus;
  }

  /** Start an MCP server as a child process. */
  async startServer(config: MCPServerConfig): Promise<void> {
    if (this.servers.has(config.name)) {
      console.warn(`[mcp] ${config.name} already running`);
      return;
    }

    const proc = spawn(config.command, config.args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...config.env },
    });

    this.servers.set(config.name, proc);
    this.buffers.set(config.name, "");

    // Wire stdout → JSON-RPC message handler BEFORE the first request,
    // or the initialize response is dropped and the handshake times out.
    proc.stdout?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => this.onStdout(config.name, chunk));
    proc.stderr?.on("data", (b: Buffer) =>
      console.warn(`[mcp:${config.name}:stderr] ${b.toString().trimEnd()}`));

    proc.on("exit", (code) => {
      console.warn(`[mcp] ${config.name} exited code=${code}`);
      this.servers.delete(config.name);
      this.tools = this.tools.filter((t) => t.server !== config.name);
    });
    // Spawn failures (ENOENT bad interpreter path, EACCES) emit 'error', not 'exit' —
    // without this handler they surface as a silent 30s initialize timeout.
    proc.on("error", (err) => {
      console.error(`[mcp] ${config.name} spawn failed: ${err.message} (cmd=${config.command})`);
      this.servers.delete(config.name);
    });

    // Initialize MCP handshake
    await this.send(config.name, "initialize", {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "flux-studio", version: "0.3.0" },
    });

    // Send initialized notification
    this.notify(config.name, "notifications/initialized", {});

    // List tools
    const result = await this.send(config.name, "tools/list", {});
    const serverTools = (result as { tools?: MCPTool[] }).tools ?? [];
    for (const t of serverTools) {
      this.tools.push({ ...t, server: config.name });
    }

    console.log(`[mcp] ${config.name} started with ${serverTools.length} tools`);
  }

  // ── LLM dispatch through the kernel's priority bands ──────────────────────
  // Tool calls queue like scheduler Tasks: higher band first, FIFO within a
  // band, bounded concurrency. HIL-triggered triage (50) preempts queued user
  // chat (30), which preempts background asset commits (10).
  private inflight = 0;
  private readonly maxConcurrent = 2;
  private waitq: Array<{ prio: number; seq: number; tool: string; run: () => void }> = [];
  // What is actually holding a slot right now, keyed by dispatch id — so the UI
  // can render live "who is flying" per band, not just an event histogram.
  private inflightCalls = new Map<number, { prio: number; tool: string }>();
  private dispatchSeq = 0;
  // Alarm preemption (拔线): while paused, queued calls below the floor stay queued.
  private pauseFloor = 0;

  private acquire(prio: number, tool: string): Promise<number> {
    const id = this.dispatchSeq++;
    if (prio >= this.pauseFloor && this.inflight < this.maxConcurrent) {
      this.inflight++;
      this.inflightCalls.set(id, { prio, tool });
      this.emitSchedulerState();
      return Promise.resolve(id);
    }
    return new Promise((resolve) => {
      this.waitq.push({ prio, seq: id, tool, run: () => {
        this.inflight++;
        this.inflightCalls.set(id, { prio, tool });
        resolve(id);
      } });
      this.waitq.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
      this.drain();
      this.emitSchedulerState();
    });
  }

  private releaseSlot(id: number): void {
    this.inflight--;
    this.inflightCalls.delete(id);
    this.drain();
    this.emitSchedulerState();
  }

  private drain(): void {
    while (this.inflight < this.maxConcurrent && this.waitq.length > 0
           && this.waitq[0]!.prio >= this.pauseFloor) {
      this.waitq.shift()!.run();
    }
  }

  /** Alarm preemption: hold every queued call below `priority` until resume(). */
  pauseBelow(priority: number): void {
    this.pauseFloor = priority;
    this.emitSchedulerState();
  }

  resume(): void {
    this.pauseFloor = 0;
    this.drain();
    this.emitSchedulerState();
  }

  /**
   * Publish a live snapshot of the scheduler for the UI. This is the RTOS
   * heartbeat — inflight/queued per priority band + the current preemption
   * floor — so the studio can show real scheduling state, not a text log.
   */
  private emitSchedulerState(): void {
    void this.bus.publish({
      source: "kernel:scheduler",
      kind: "measure",
      topic: "scheduler.state",
      data: {
        maxConcurrent: this.maxConcurrent,
        inflight: this.inflight,
        pauseFloor: this.pauseFloor,
        inflightCalls: [...this.inflightCalls.values()],
        queued: this.waitq.map((w) => ({ prio: w.prio, tool: w.tool })),
      },
      trace_id: randomUUID(),
    });
  }

  /**
   * Scheduler demo task: occupy a real queue slot at `prio` for `ms` without
   * hitting a server. It drives the SAME acquire → queue → preempt → release
   * path as callTool, so the live scheduler.state reflects genuine band
   * contention and alarm preemption — honest, not a canned animation.
   */
  async runDemoTask(prio: number, label: string, ms: number): Promise<void> {
    const id = await this.acquire(prio, label);
    try {
      await new Promise((r) => setTimeout(r, ms));
    } finally {
      this.releaseSlot(id);
    }
  }

  /** Call a tool by name. Routes to the owning server via the priority queue. */
  async callTool(toolName: string, args: Record<string, unknown> = {}, priority: number = Priority.Agent): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`MCP tool not found: ${toolName}. Available: ${this.tools.map((t) => t.name).join(", ")}`);
    }

    // LLM/vision tool calls can run for minutes — far past the 30s handshake timeout.
    const slot = await this.acquire(priority, toolName);
    const t0 = Date.now();
    let result: unknown;
    try {
      result = await this.send(tool.server, "tools/call", {
        name: toolName,
        arguments: args,
      }, 300_000);
    } finally {
      this.releaseSlot(slot);
    }

    // Publish result as uORB event for UI + recorder (durationMs/priority feed
    // the trajectory factory and the flywheel dashboard).
    const event: Event = {
      source: `mcp:${tool.server}`,
      kind: "execute",
      topic: `mcp.tool.result`,
      data: { tool: toolName, args, result, durationMs: Date.now() - t0, priority },
      trace_id: randomUUID(),
    };
    await this.bus.publish(event);

    return result;
  }

  /** List all available tools (from all servers). */
  listTools(): MCPTool[] {
    return [...this.tools];
  }

  /** Stop a specific server. */
  stopServer(name: string): void {
    const proc = this.servers.get(name);
    if (proc) {
      proc.kill("SIGTERM");
      this.servers.delete(name);
      this.tools = this.tools.filter((t) => t.server !== name);
    }
  }

  /** Stop all servers. */
  async stopAll(): Promise<void> {
    for (const name of this.servers.keys()) {
      this.stopServer(name);
    }
  }

  // ── Internal JSON-RPC over stdio ────────────────────────────────────────────

  private onStdout(serverName: string, chunk: string): void {
    let buf = (this.buffers.get(serverName) ?? "") + chunk;
    // MCP messages are newline-delimited JSON (or Content-Length framed)
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        this.onMessage(serverName, msg);
      } catch {
        // Might be Content-Length framed — try that
        if (line.startsWith("Content-Length:")) {
          const len = parseInt(line.split(":")[1]?.trim() ?? "0", 10);
          const body = buf.slice(0, len);
          buf = buf.slice(len);
          try {
            const msg = JSON.parse(body);
            this.onMessage(serverName, msg);
          } catch { /* skip */ }
        }
      }
    }
    this.buffers.set(serverName, buf);
  }

  private onMessage(serverName: string, msg: Record<string, unknown>): void {
    // Response to a request
    if (msg.id && this.pending.has(String(msg.id))) {
      const req = this.pending.get(String(msg.id))!;
      this.pending.delete(String(msg.id));
      clearTimeout(req.timeout);
      if (msg.error) {
        const errMsg = (msg.error as { message?: string }).message ?? "MCP error";
        req.reject(new Error(String(errMsg)));
      } else {
        req.resolve(msg.result);
      }
    }
    // Notification from server (e.g., progress, log)
    if (!msg.id && msg.method) {
      // Publish as uORB event
      const event: Event = {
        source: `mcp:${serverName}`,
        kind: "log",
        topic: `mcp.notification`,
        data: { method: msg.method, params: msg.params },
        trace_id: randomUUID(),
      };
      void this.bus.publish(event);
    }
  }

  private send(serverName: string, method: string, params: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const proc = this.servers.get(serverName);
      if (!proc || !proc.stdin) {
        reject(new Error(`MCP server not running: ${serverName}`));
        return;
      }
      const id = randomUUID();
      const msg = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method} on ${serverName} (${Math.round(timeoutMs / 1000)}s)`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      proc.stdin.write(msg);
    });
  }

  private notify(serverName: string, method: string, params: Record<string, unknown>): void {
    const proc = this.servers.get(serverName);
    if (!proc?.stdin) return;
    const msg = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
    proc.stdin.write(msg);
  }
}
