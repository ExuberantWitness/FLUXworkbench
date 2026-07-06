# ADR 0002 — Hybrid bus (revises #9 "全 Zenoh")

- **Status**: accepted
- **Date**: 2025-07-05
- **Revises**: ADR 0001 decision #9 (uORB transport = 全 Zenoh)
- **Trigger**: Zenoh three-language spike (`docs/v2/zenoh-spike.md`)

## Context

Spike found `@eclipse-zenoh/zenoh-ts@1.9.0` is **not a native Node peer** — it is a WebSocket client to a `zenohd` router running `zenoh-plugin-remote-api`. So "全 Zenoh" forces a zenohd router process whenever the TS studio participates, plus a WS hop. zenoh-python (and zenoh-c) are native peers (no router needed; Py↔Py measured at 4.1 ms median RTT).

## Decision

**Hybrid bus**:

- **Local TS ↔ Python brain**: **Node IPC / JSON-RPC**. The Python brain is a supervised single subprocess of the TS base (VSCode-extension-model). Parent↔child stdio/IPC is the fastest, simplest seam — no router, no WS hop.
- **Zenoh (native peers)** for everything genuinely peer/distributed:
  - OpenOCD embodied-agent peer (C subprocess on the bus)
  - future sim modules
  - **remote (Tailscale)** access
- **uORB topic model spans both**: the same typed messages flow over Node IPC (TS↔Python) and Zenoh (peer/remote). A thin `Bus` abstraction in the kernel hides which transport carries a given pub/sub.

## Consequences

- **+** No zenohd router for the common local-only case (lower latency, simpler ops).
- **+** Local TS↔Python latency becomes Node IPC (~sub-ms), not 4 ms Zenoh + WS.
- **+** Zenoh retained where it earns its keep (peer modules, remote).
- **−** Two transports behind one `Bus` interface — must keep uORB message encoding identical across them (protobuf bytes over both).
- **−** Remote TS peer (e.g. a second studio on Tailscale) still needs the router path or a Python broker — deferred to mod-tailscale (v2).

## uORB transport matrix (v1)

| Path | Transport | Why |
|---|---|---|
| TS kernel ↔ Python brain | Node IPC (JSON-RPC over stdio) | parent↔child subprocess, fastest |
| TS kernel ↔ OpenOCD (C peer) | Zenoh (native peer) | peer module, future RT pinning |
| Python brain ↔ OpenOCD | Zenoh (native peer) | peer modules |
| TS kernel ↔ remote (Tailscale) | Zenoh via mod-tailscale broker (v2) | remote |
