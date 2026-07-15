// Event recorder + trajectory factory — the evidence machine's foundation (P0).
//
// The bus is in-memory only; this module is the single durable capture point:
//   1. EventRecorder  — every bus event → FLUX_HOME/events/<date>.jsonl
//                       (replayable, queryable — evidence bundles read from here)
//   2. TrajectoryWriter — per-mission training-format corpus:
//                       FLUX_HOME/trajectories/<mission_id>.jsonl
//                       (schema v1: action | observation | outcome lines)
//
// Secrets (apiKey/authorization/...) are redacted before anything touches disk.

import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { Bus } from "./bus";
import type { Event } from "./types";

export function fluxHome(): string {
  return process.env["FLUX_HOME"] ?? path.join(os.homedir(), ".flux");
}

const SECRET_KEYS = new Set(["apikey", "api_key", "authorization", "password", "secret", "token"]);

/** Deep-copy with secret values replaced — corpus and evidence must be shareable. */
export function redactSecrets(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEYS.has(k.toLowerCase()) ? "[redacted]" : redactSecrets(v, depth + 1);
  }
  return out;
}

interface RecordedEvent {
  ts: number;
  topic: string;
  kind: string;
  source: string;
  trace_id: string;
  data: Record<string, unknown>;
}

export interface EventQuery {
  sinceTs?: number;
  topicPrefix?: string;
  traceIdPrefix?: string;
  limit?: number;
}

export class EventRecorder {
  private dir: string;

  constructor(private bus: Bus) {
    this.dir = path.join(fluxHome(), "events");
  }

  /** Subscribe every topic; each event becomes one JSONL line in today's file. */
  async start(topics: string[]): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    for (const t of topics) {
      await this.bus.subscribe(t, (e: Event) => this.append(e));
    }
  }

  private append(e: Event): void {
    const line: RecordedEvent = {
      ts: Date.now(),
      topic: e.topic,
      kind: e.kind,
      source: e.source,
      trace_id: e.trace_id,
      data: redactSecrets(e.data) as Record<string, unknown>,
    };
    const day = new Date().toISOString().slice(0, 10);
    try {
      appendFileSync(path.join(this.dir, `${day}.jsonl`), JSON.stringify(line) + "\n");
    } catch (err) {
      console.warn("[recorder]", (err as Error).message);
    }
  }

  /** Read back recorded events (evidence bundles, replay). Scans newest files first. */
  queryEvents(q: EventQuery = {}): RecordedEvent[] {
    if (!existsSync(this.dir)) return [];
    const files = readdirSync(this.dir).filter((f) => f.endsWith(".jsonl")).sort().reverse().slice(0, 7);
    const out: RecordedEvent[] = [];
    for (const f of files) {
      for (const raw of readFileSync(path.join(this.dir, f), "utf8").split("\n")) {
        if (!raw.trim()) continue;
        let e: RecordedEvent;
        try { e = JSON.parse(raw) as RecordedEvent; } catch { continue; }
        if (q.sinceTs && e.ts < q.sinceTs) continue;
        if (q.topicPrefix && !e.topic.startsWith(q.topicPrefix)) continue;
        if (q.traceIdPrefix && !e.trace_id.startsWith(q.traceIdPrefix)) continue;
        out.push(e);
      }
    }
    out.sort((a, b) => a.ts - b.ts);
    return q.limit ? out.slice(-q.limit) : out;
  }
}

// ── Trajectory factory — training format IS the storage format (schema v1) ──

export interface TrajectoryLine {
  ts: number;
  kind: "action" | "observation" | "outcome";
  tool?: string;
  args?: unknown;
  result_text?: string;
  trace_id?: string;
  data?: Record<string, unknown>;
}

const RESULT_CAP = 8192;

export class TrajectoryWriter {
  private file: string;

  constructor(missionId: string) {
    const dir = path.join(fluxHome(), "trajectories");
    mkdirSync(dir, { recursive: true });
    this.file = path.join(dir, `${missionId}.jsonl`);
  }

  record(line: Omit<TrajectoryLine, "ts">): void {
    const entry: TrajectoryLine = {
      ts: Date.now(),
      ...line,
      args: line.args !== undefined ? redactSecrets(line.args) : undefined,
      result_text: line.result_text?.slice(0, RESULT_CAP),
    };
    try {
      appendFileSync(this.file, JSON.stringify(entry) + "\n");
    } catch (err) {
      console.warn("[trajectory]", (err as Error).message);
    }
  }
}

/** Dashboard counter: how much corpus the flywheel has produced. */
export function trajectoryStats(): { missions: number; lines: number } {
  const dir = path.join(fluxHome(), "trajectories");
  if (!existsSync(dir)) return { missions: 0, lines: 0 };
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  let lines = 0;
  for (const f of files) {
    try {
      lines += readFileSync(path.join(dir, f), "utf8").split("\n").filter((l) => l.trim()).length;
    } catch { /* unreadable file — skip */ }
  }
  return { missions: files.length, lines };
}
