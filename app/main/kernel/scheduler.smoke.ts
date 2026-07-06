// Scheduler smoke test — verifies priority ordering + dep gating.
// Run with Node 22+ type stripping (after wiring .ts extension resolution):
//   node --experimental-strip-types --experimental-detect-module scheduler.smoke.ts
// (Or compile via tsc and run the .js — see CI.)
import { Scheduler } from "./scheduler";
import { Priority } from "./types";
import type { Task } from "./types";

function task(name: string, priority: Priority, deps: string[] = []): Task {
  return {
    identity: { name, description: "" },
    trigger: "parent",
    flow: { mode: "leaf" },
    runtime: { priority, isolation: "in-process", ipc: "topic" },
    deps,
    manifestRef: "",
  };
}

// Phase 1: priority — alarm (p90) must come out before build/agent (p30).
const a = new Scheduler();
a.enqueue(task("build", Priority.Build));
a.enqueue(task("alarm", Priority.Alarm));
a.enqueue(task("agent", Priority.Agent));
const p1 = a.pick();
console.log("phase1 priority:", p1?.identity.name, "expect=alarm");
if (p1?.identity.name !== "alarm") throw new Error("priority order wrong");

// Phase 2: dep gating — 'flash' depends on a 'build' token not yet satisfied → nothing dispatchable.
const b = new Scheduler();
b.enqueue(task("flash", Priority.Agent, ["build"]));
const p2 = b.pick();
console.log("phase2 blocked:", p2?.identity.name ?? "(none)", "expect=(none)");
if (p2) throw new Error("dep gate leaked");

// Phase 3: satisfy 'build' → 'flash' released.
b.satisfy("build");
const p3 = b.pick();
console.log("phase3 released:", p3?.identity.name, "expect=flash");
if (p3?.identity.name !== "flash") throw new Error("dep release failed");

console.log("OK — scheduler priority + dep gating pass");
