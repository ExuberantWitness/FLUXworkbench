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
  private waitq: Array<{ prio: number; seq: number; run: () => void }> = [];
  private dispatchSeq = 0;

  private acquire(prio: number): Promise<void> {
    if (this.inflight < this.maxConcurrent) {
      this.inflight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waitq.push({ prio, seq: this.dispatchSeq++, run: () => { this.inflight++; resolve(); } });
      this.waitq.sort((a, b) => b.prio - a.prio || a.seq - b.seq);
    });
  }

  private releaseSlot(): void {
    this.inflight--;
    this.waitq.shift()?.run();
  }

  /** Call a tool by name. Routes to the owning server via the priority queue. */
  async callTool(toolName: string, args: Record<string, unknown> = {}, priority: number = Priority.Agent): Promise<unknown> {
    const tool = this.tools.find((t) => t.name === toolName);
    if (!tool) {
      throw new Error(`MCP tool not found: ${toolName}. Available: ${this.tools.map((t) => t.name).join(", ")}`);
    }

    // LLM/vision tool calls can run for minutes — far past the 30s handshake timeout.
    await this.acquire(priority);
    let result: unknown;
    try {
      result = await this.send(tool.server, "tools/call", {
        name: toolName,
        arguments: args,
      }, 300_000);
    } finally {
      this.releaseSlot();
    }

    // Publish result as uORB event for UI
    const event: Event = {
      source: `mcp:${tool.server}`,
      kind: "execute",
      topic: `mcp.tool.result`,
      data: { tool: toolName, args, result },
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
