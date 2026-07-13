// TrainingAgent — UnitPort RL training as a kernel-scheduled embodied task.
//
// The UnitPort SB3 launcher is already a headless protocol: spec JSON on
// stdin, JSON-line events (MSG_PROGRESS/METRICS/FINISHED/ERROR/CANCELLED) on
// stdout. The kernel spawns it directly — the subprocess boundary is the
// isolation unit — tails stdout onto the bus as training.* topics, and
// cancel is a process kill. No Qt orchestration layer involved.

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import type { Bus } from "../bus";

function repoRoot(): string {
  const fromHere = path.resolve(__dirname, "..", "..", "..", "..");
  return existsSync(path.join(fromHere, "brain")) ? fromHere : process.cwd();
}

export interface TrainingRun {
  runId: string;
  proc: ChildProcess;
  startedAt: number;
}

export class TrainingAgent {
  private runs = new Map<string, TrainingRun>();
  private seq = 0;

  constructor(private readonly bus: Bus) {}

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
      this.runs.delete(runId);
      void this.publish("training.finished", { runId, exitCode: code });
    });

    this.runs.set(runId, { runId, proc, startedAt: Date.now() });
    void this.publish("training.started", { runId });
    return runId;
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

  cancel(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    run.proc.kill("SIGTERM");
    return true;
  }

  list(): Array<{ runId: string; startedAt: number }> {
    return [...this.runs.values()].map((r) => ({ runId: r.runId, startedAt: r.startedAt }));
  }

  private publish(topic: string, data: Record<string, unknown>): Promise<void> {
    return this.bus.publish({
      source: "training-agent", kind: "execute", topic, data,
      trace_id: String(data["runId"] ?? ""),
    });
  }
}
