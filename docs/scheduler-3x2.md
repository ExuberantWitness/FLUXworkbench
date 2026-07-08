# Scheduler: 3-Axis × 2-Resource

> Plan decision #6; the infrastructure core IP.

## 3 Axes

| Axis | Meaning | Values |
|---|---|---|
| **flow** | task process shape | leaf / sequential / parallel / loop / graph(DAG) / delegate |
| **time** | when to run | parent / cron / event / webhook / manual / irq |
| **priority** | urgency (RTOS "硬件不等人") | 90 alarm > 70 device > 50 hil > 30 build/agent/asset > 10 bg |

## 2 Resource Pools

| Pool | Contents | v1 scope |
|---|---|---|
| **compute** | CPU cores / threads / processes / accelerators + per-subagent capability set | priority queue + dep gating (v1); core pinning (v2) |
| **storage** | session / prompt cache / memory / external files | session chunk + lineage (v1); full eviction/compress (v2) |

## Implementation

`scheduler.ts` — `Scheduler` class with:
- `enqueue(task)` → priority-sorted ready queue
- `satisfy(token)` → mark a dep as met
- `pick()` → highest-priority ready Task whose deps are all satisfied
- `peakPriority()` → for preemption checks

Verified: scheduler.smoke.ts (3-phase: priority ordering + dep gating + release).
