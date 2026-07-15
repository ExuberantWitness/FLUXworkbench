// Mission engine — the flywheel's unit of measurement (P1).
//
// A Mission is one device-onboarding session: plug in → identify → ingest →
// plan → verify → commit. Every phase transition is bus-published and
// timestamped; on finish the engine computes the metrics the dashboard
// curve is drawn from (time-to-devready, asset hits, tool calls) and the
// TrajectoryWriter has captured the session as training-format corpus.

import type { Bus } from "./bus";
import type { Event } from "./types";
import { TrajectoryWriter } from "./recorder";

export type MissionPhase = "identify" | "ingest" | "plan" | "verify" | "commit";
export const MISSION_PHASES: MissionPhase[] = ["identify", "ingest", "plan", "verify", "commit"];

export interface MissionRecord {
  missionId: string;
  goal: string;
  deviceFamily: string;
  startedAt: number;
  finishedAt?: number;
  milestones: Array<{ phase: string; status: "start" | "done" | "fail"; ts: number; detail?: string }>;
  verdict?: "PASS" | "FAIL" | "ERROR";
  assetHits: number;
  toolCalls: number;
  timeToDevreadyMs?: number;
}

export class MissionEngine {
  private missions = new Map<string, { rec: MissionRecord; traj: TrajectoryWriter }>();
  private history: MissionRecord[] = [];
  private seq = 0;

  constructor(private bus: Bus) {
    // One subscription set routes to whichever missions are live — the
    // trajectory factory's capture point for actions and observations.
    void this.bus.subscribe("mcp.tool.result", (e: Event) => {
      const d = e.data as { tool?: string; args?: unknown; result?: unknown; durationMs?: number };
      const text = (d.result as { content?: Array<{ text?: string }> })?.content?.[0]?.text;
      this.forEachActive((m) => {
        m.rec.toolCalls++;
        m.traj.record({
          kind: "action", tool: d.tool, args: d.args,
          result_text: text, trace_id: e.trace_id,
          data: { durationMs: d.durationMs },
        });
      });
    });
    void this.bus.subscribe("asset.committed", (e: Event) => {
      this.forEachActive((m) => {
        m.rec.assetHits++;
        m.traj.record({ kind: "observation", data: { topic: e.topic, ...e.data }, trace_id: e.trace_id });
      });
    });
    void this.bus.subscribe("hil.step", (e: Event) => {
      this.forEachActive((m) =>
        m.traj.record({ kind: "observation", data: { topic: e.topic, ...e.data }, trace_id: e.trace_id }));
    });
  }

  private forEachActive(fn: (m: { rec: MissionRecord; traj: TrajectoryWriter }) => void): void {
    for (const m of this.missions.values()) {
      if (!m.rec.finishedAt) fn(m);
    }
  }

  start(goal: string, deviceFamily: string): string {
    const missionId = `mission-${Date.now()}-${this.seq++}`;
    const rec: MissionRecord = {
      missionId, goal, deviceFamily, startedAt: Date.now(),
      milestones: [], assetHits: 0, toolCalls: 0,
    };
    this.missions.set(missionId, { rec, traj: new TrajectoryWriter(missionId) });
    void this.publish(missionId, "mission", "start", goal);
    return missionId;
  }

  milestone(missionId: string, phase: MissionPhase, status: "start" | "done" | "fail", detail?: string): void {
    const m = this.missions.get(missionId);
    if (!m) return;
    m.rec.milestones.push({ phase, status, ts: Date.now(), detail });
    void this.publish(missionId, phase, status, detail);
  }

  finish(missionId: string, verdict: "PASS" | "FAIL" | "ERROR", detail?: string): MissionRecord | null {
    const m = this.missions.get(missionId);
    if (!m) return null;
    m.rec.finishedAt = Date.now();
    m.rec.verdict = verdict;
    m.rec.timeToDevreadyMs = m.rec.finishedAt - m.rec.startedAt;
    m.traj.record({ kind: "outcome", data: { verdict, timeToDevreadyMs: m.rec.timeToDevreadyMs, detail } });
    this.history.push(m.rec);
    this.missions.delete(missionId);
    void this.publish(missionId, "mission", verdict === "PASS" ? "done" : "fail",
      `${verdict} in ${Math.round(m.rec.timeToDevreadyMs / 1000)}s`);
    return m.rec;
  }

  trajectory(missionId: string): TrajectoryWriter | null {
    return this.missions.get(missionId)?.traj ?? null;
  }

  list(): MissionRecord[] {
    return [...this.history, ...[...this.missions.values()].map((m) => m.rec)];
  }

  private publish(missionId: string, phase: string, status: string, detail?: string): Promise<void> {
    return this.bus.publish({
      source: "mission-engine", kind: "execute", topic: "mission.milestone",
      data: { missionId, phase, status, detail: detail ?? "" },
      trace_id: missionId,
    });
  }
}
