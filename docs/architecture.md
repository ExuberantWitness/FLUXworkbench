# Flux Workbench v2 — Architecture

> Authoritative plan: `~/.claude/plans/plan-cozy-snowflake.md`. This doc is the in-repo condensed reference.

## Two cores

**Infrastructure core** — a unified scheduler along 3 orthogonal axes over 2 resource pools:

- **3 axes**: `flow` (task DAG: seq/parallel/loop/graph) × `time` (parallel/cron/event/webhook/IRQ) × `priority` ("硬件不等人": alarm 90 > device 70 > hil 50 > build/agent 30 > bg 10)
- **2 resources**: `compute` (cores/threads/processes/accelerators + per-subagent capability set) × `storage` (session/prompt/memory/files, full memory-hierarchy scheduling)
- All-process microkernel; capability-signed manifests; uORB-over-Zenoh bus (zenoh-ts/c/python); preemption by pinning priority bands to dedicated cores (`SCHED_FIFO`).

**Application core** — four primitives, all = `Task` specializations (not peers):

| Primitive | = Task shape | Notes |
|---|---|---|
| `subagent` | Task + capability manifest | physical subagent (OpenOCD/motor/instrument) = **first-class embodied agent**; logical (MiniCPM5 VLM, agent) alike |
| `loop` | Task `flow.mode=Loop` + policy gate | autonomous continuous R&D loop (probe→characterize→driver→verify→commit→next); policy-gate-interruptible |
| `devready` | Task producing/committing DevelopReady assets | **separate from storage** (storage = session/prompt/memory) |
| `simulation` | Task running a sim engine (Renode/MuJoCo) | emits sim state; two-layer sim (MCU / robot), v2 |
| `workflow` | Task `flow.mode=Graph` (DAG) | orchestrates the above; **Python produces flow, TS dispatches** |

## Ported from v0 `flux-runtime/primitives.py` (do not lose this design)

v0's four-primitive ontology maps cleanly onto v2's TS Task + Zenoh uORB:

| v0 (Python) | v2 (TS Task / Zenoh) |
|---|---|
| `Message{target,op,args,trace_id}` | uORB **command topic** (with `trace_id` → lineage) |
| `Event{source,kind,data,trace_id}` | uORB **event topic**; `kind` ∈ propose/predict/execute/measure/attribute/log/error |
| `Subagent.step(msg)→Event*` | subagent-Task subscribing command topic, publishing event topic |
| `Loop` phases research/write/execute/debug + `intervene()` | `loop`-Task + **policy gate** (the intervene point) |
| `Asset.calibrate/health/export` (PHM) | `devready`-Task + asset module (health/drift tracking) |
| `Bundle`/`Scene`, `World.push/predict` | `simulation`-Task; `predict` = predict-before-act safety gate |

## VSCode-model layering (three languages)

- **TS base** (`app/`): Electron app + React/Monaco UI (仿 VSCode 布局) + **kernel** (scheduler/capability/supervisor/mode-manager/uORB-over-Zenoh). Kernel runs in Electron main; orchestrates everything; **does not depend on Python**.
- **Python execution** (`brain/`): single process (preserves OpenRath in-memory Session model); produces workflow flow (DAG); OpenRath-reconstructed agent/session/storage/asset. **Does not dispatch** — TS kernel dispatches.
- **C tool** (`native/openocd/`): OpenOCD TCL-RPC driver subprocess (embodied agent); future motor/CAN/SPI. Hardware control path **does not go through Python**.

**Purity**: hardware-control path = TS kernel + C OpenOCD, no Python required. Python AI brain is an enhancement layer.

## Orchestration boundary

- **Python** produces `flow` (workflow DAG: what to do, order).
- **TS scheduler** dispatches along `flow + time + priority` to `compute/storage` (when/which-core/priority).
- Python does **not** dispatch; TS does. Two centers don't collide.

## Capability model

Each module ships a signed `capability.yaml` (identity + `touch-hardware` / `publish-topics` / `subscribe-topics` / `compute` / `storage` / `call-mcp` + ed25519 signature). TS kernel verifies signature at spawn, enforces per Zenoh pub/sub + hardware call. Unauthorized → reject + `alarm.policy-violation`. **PKI v1 = project self-sign** (`~/.flux/keys/`); v2 org CA; v3 web-of-trust.

## UI auth

Local UI = trusted (loopback + app-signed manifest), publishes Zenoh directly. Remote (Tailscale) = must go through `mod-tailscale` broker (verifies org-signed manifest, capability-checks each command, republishes locally).

## RT (v1 soft)

V8 / Python GIL can't preempt in-process → inter-module preemption is OS-level (`SCHED_FIFO` + core pinning per process). **v1 = soft RT (no pinning)**, hard RT deferred. OpenOCD (C binary) owns the RT thread when hard RT lands.

## v1 vertical (HPM6E00 + OpenOCD, real board)

```
TS kernel boot → spawn C OpenOCD (embodied agent) → device.attached
  → Python agent (loop) subscribes, runs board-bringup workflow
  → build-task (riscv GCC + HPM_SDK + CMake) → build.progress
  → OpenOCD flash + halt/mdw (real board)
  → agent characterize + driver skeleton + bench (Session lineage)
  → devready commits multi-modal asset bundle → asset.committed
  → over-current / probe-loss → alarm (p90) preempts
  → TS studio renders; next agent session reuses lineage + asset.search
```

See plan §验证 for the 15-step acceptance.
