// TrainingAgent — UnitPort RL training as a kernel-scheduled embodied task.
//
// The UnitPort SB3 launcher is already a headless protocol: spec JSON on
// stdin, JSON-line events (MSG_PROGRESS/METRICS/FINISHED/ERROR/CANCELLED) on
// stdout. The kernel spawns it directly — the subprocess boundary is the
// isolation unit — tails stdout onto the bus as training.* topics, and
// cancel is a process kill. No Qt orchestration layer involved.
//
// Checkpoint resume (P6/W1): every start persists its full envelope to
// ~/.flux/training/runs.json; resume() re-spawns the SAME runId with
// spec.algorithm.checkpoint injected. The latest checkpoint is resolved by
// globbing *.zip ourselves — upstream's resolver only looks for *.pt and its
// step parser reads the wrong token, so it is deliberately not used.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Bus } from "../bus";

function repoRoot(): string {
  const fromHere = path.resolve(__dirname, "..", "..", "..", "..");
  return existsSync(path.join(fromHere, "brain")) ? fromHere : process.cwd();
}

function fluxHome(): string {
  return process.env["FLUX_HOME"] ?? path.join(os.homedir(), ".flux");
}

export interface RunEntry {
  runId: string;
  payload: Record<string, unknown>;
  status: "running" | "finished" | "failed" | "cancelled";
  startedAt: number;
  finishedAt?: number;
  exitCode?: number | null;
  resumes?: number;
}

export class TrainingAgent {
  private procs = new Map<string, ChildProcess>();
  private seq = 0;
  private registryFile: string;

  constructor(private readonly bus: Bus) {
    const dir = path.join(fluxHome(), "training");
    mkdirSync(dir, { recursive: true });
    this.registryFile = path.join(dir, "runs.json");
  }

  // ── persistent run registry (atomic replace) ──
  private readRegistry(): Record<string, RunEntry> {
    try { return JSON.parse(readFileSync(this.registryFile, "utf8")) as Record<string, RunEntry>; }
    catch { return {}; }
  }

  private patchRegistry(runId: string, patch: Partial<RunEntry>): void {
    const reg = this.readRegistry();
    reg[runId] = { ...(reg[runId] ?? { runId, payload: {}, status: "running", startedAt: Date.now() }), ...patch };
    const tmp = `${this.registryFile}.tmp`;
    writeFileSync(tmp, JSON.stringify(reg, null, 1));
    renameSync(tmp, this.registryFile);
  }

  /** Start an SB3 training run from a compiled TrainingSpec (JSON object). */
  start(spec: Record<string, unknown>, opts?: { totalTimesteps?: number; exportBundle?: boolean }): string {
    const runId = `train-${Date.now()}-${++this.seq}`;
    // sb3_entry expects an envelope: {spec, run_id, total_timesteps, export_bundle}.
    // Accept either a bare spec or a ready-made payload.
    const payload: Record<string, unknown> = "spec" in spec ? { ...spec, run_id: runId } : {
      spec, run_id: runId,
      total_timesteps: opts?.totalTimesteps ?? null,
      export_bundle: opts?.exportBundle ?? true,
    };
    this.patchRegistry(runId, { runId, payload, status: "running", startedAt: Date.now() });
    this.launch(runId, payload);
    return runId;
  }

  /** Resume a stopped run from its newest checkpoint, same runId (checkpoint
   * numbering continues in the same run_dir). Returns null when impossible. */
  resume(runId: string): string | null {
    if (this.procs.has(runId)) return null; // still running
    const entry = this.readRegistry()[runId];
    if (!entry?.payload || !("spec" in entry.payload)) return null;
    const ckpt = this.resolveLatestCheckpoint(runId);
    if (!ckpt) return null;

    const payload = JSON.parse(JSON.stringify(entry.payload)) as Record<string, unknown>;
    const spec = payload["spec"] as Record<string, unknown>;
    const algo = (spec["algorithm"] ?? {}) as Record<string, unknown>;
    // spec-level resume is already supported upstream: PPO/SAC/TD3.load(...)
    // + reset_num_timesteps=False — steps continue from the checkpoint.
    algo["checkpoint"] = { checkpoint_file: ckpt, load_mode: "resume", start_point: "", asset_id: "" };
    spec["algorithm"] = algo;
    payload["spec"] = spec;
    payload["run_id"] = runId;

    this.patchRegistry(runId, {
      payload, status: "running",
      resumes: (entry.resumes ?? 0) + 1,
    });
    this.launch(runId, payload);
    return runId;
  }

  /** Newest SB3 checkpoint for a run: glob *.zip, order by the FIRST integer
   * in the filename (model_50000_steps.zip → 50000). */
  resolveLatestCheckpoint(runId: string): string | null {
    const dir = path.join(repoRoot(), "vendor", "integrations", "UnitPort",
      "training", "runs", "sb3_mujoco", runId, "checkpoints");
    if (!existsSync(dir)) return null;
    let best: { steps: number; file: string } | null = null;
    for (const f of readdirSync(dir).filter((f) => f.endsWith(".zip"))) {
      const m = f.match(/\d+/);
      const steps = m ? parseInt(m[0], 10) : -1;
      if (steps >= 0 && (!best || steps > best.steps)) best = { steps, file: f };
    }
    return best ? path.join(dir, best.file) : null;
  }

  private launch(runId: string, payload: Record<string, unknown>): void {
    const root = repoRoot();
    const py = process.env["FLUX_UNITPORT_PY"]
      ?? path.join(root, "vendor", "integrations", ".venv-unitport", "bin", "python");
    const upRoot = path.join(root, "vendor", "integrations", "UnitPort");
    const proc = spawn(py, ["-c",
      "import sys; sys.path.insert(0, 'src'); from application.training.launcher.sb3_entry import main; main()"],
      { cwd: upRoot, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, PYTHONUNBUFFERED: "1" } });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    let buf = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line.startsWith("{")) this.onEvent(runId, line);
      }
    });
    proc.stderr.on("data", (b: Buffer) =>
      console.warn(`[training:${runId}] ${b.toString().trimEnd().slice(0, 200)}`));
    proc.on("exit", (code) => {
      const cancelled = this.cancelled.delete(runId);
      this.procs.delete(runId);
      this.patchRegistry(runId, {
        status: cancelled ? "cancelled" : code === 0 ? "finished" : "failed",
        finishedAt: Date.now(), exitCode: code,
      });
      void this.publish("training.finished", { runId, exitCode: code });
    });

    this.procs.set(runId, proc);
    void this.publish("training.started", { runId });
  }

  private onEvent(runId: string, line: string): void {
    try {
      const msg = JSON.parse(line) as Record<string, unknown>;
      const kind = String(msg["type"] ?? msg["msg"] ?? "log").toLowerCase();
      const topic = kind.includes("metric") ? "training.metrics"
        : kind.includes("progress") ? "training.progress"
        : kind.includes("finish") ? "training.finished"
        : kind.includes("error") || kind.includes("cancel") ? "training.error"
        : "training.log";
      void this.publish(topic, { runId, ...msg });
    } catch { /* non-JSON stdout noise */ }
  }

  private cancelled = new Set<string>();

  cancel(runId: string): boolean {
    const proc = this.procs.get(runId);
    if (!proc) return false;
    this.cancelled.add(runId);
    proc.kill("SIGTERM");
    return true;
  }

  /** Registry-backed history (survives studio restarts) + live flag. */
  list(): Array<{ runId: string; startedAt: number; status: string; live: boolean; resumable: boolean; resumes: number }> {
    const reg = this.readRegistry();
    return Object.values(reg)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, 50)
      .map((e) => ({
        runId: e.runId, startedAt: e.startedAt,
        status: this.procs.has(e.runId) ? "running" : e.status,
        live: this.procs.has(e.runId),
        resumable: !this.procs.has(e.runId) && this.resolveLatestCheckpoint(e.runId) !== null,
        resumes: e.resumes ?? 0,
      }));
  }

  private publish(topic: string, data: Record<string, unknown>): Promise<void> {
    return this.bus.publish({
      source: "training-agent", kind: "execute", topic, data,
      trace_id: String(data["runId"] ?? ""),
    });
  }
}
