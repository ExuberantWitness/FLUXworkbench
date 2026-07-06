// Flux kernel — unified scheduler (infrastructure core).
//
// 3 axes (flow / time / priority) × 2 resources (compute / storage).
// v1 minimal: priority-driven dispatch of Tasks whose deps are satisfied.
// Soft RT (no core pinning); hard RT (SCHED_FIFO + affinity) deferred.
//
// The four application primitives are Task specializations; `workflow` is a
// flow.mode = "graph" Task. This file treats them uniformly.

import type { Priority, Task, TaskState } from "./types";

export interface ScheduledTask extends Task {
  state: TaskState;
  enqueuedAt: number;
}

/**
 * Priority queue + dep-gated dispatcher. Highest priority wins; among equal
 * priorities, FIFO by enqueuedAt. A Task is dispatchable when its `deps`
 * (task names or "topic:<event-topic>" tokens) are all satisfied.
 */
export class Scheduler {
  private ready: ScheduledTask[] = [];
  private readonly satisfied: Set<string> = new Set();

  enqueue(t: Task): ScheduledTask {
    const st: ScheduledTask = { ...t, state: "ready", enqueuedAt: Date.now() };
    this.ready.push(st);
    // stable by priority desc, then enqueue order
    this.ready.sort((a, b) => b.runtime.priority - a.runtime.priority || a.enqueuedAt - b.enqueuedAt);
    return st;
  }

  /** Mark a task-name or topic-token as satisfied (releases blocked deps). */
  satisfy(token: string): void {
    this.satisfied.add(token);
  }

  /** Pick the highest-priority ready Task whose deps are all satisfied. */
  pick(): ScheduledTask | undefined {
    for (let i = 0; i < this.ready.length; i++) {
      const t = this.ready[i];
      if (!t || t.state !== "ready") continue;
      if (t.deps.every((d) => this.satisfied.has(d))) {
        this.ready.splice(i, 1);
        t.state = "running";
        return t;
      }
    }
    return undefined;
  }

  /** Peek highest priority among ready tasks (for preemption checks). */
  peakPriority(): Priority | undefined {
    for (const t of this.ready) if (t.state === "ready") return t.runtime.priority;
    return undefined;
  }

  complete(name: string, ok: boolean): void {
    this.satisfied.add(name);
    void ok;
  }

  get size(): number {
    return this.ready.length;
  }
}
