# Zenoh three-language spike — v1 Gate report

> build-task #2. Decides whether the "全 Zenoh" bus (decision #9) survives.

## Setup

- zenoh-python 1.x (via `eclipse-zenoh` on PyPI) — **native peer**, default `Config()` works.
- zenoh-ts `@eclipse-zenoh/zenoh-ts` 1.9.0 (npm) — installed; imports in Node (`Config`, `open`, `declareSubscriber`, `put`, `Session` all present).
- zenoh-c — not yet measured (lower priority, see below).
- All localhost.

## Measured

### Python ↔ Python (cross-process, native peers, no router)
RTT (pub→sub→pub echo), N=1000:
- **median 4.1 ms, p99 4.2 ms, max 4.2 ms, 0 loss**
- send-rate ~87k msg/s (one-way latency ≈ RTT/2 ≈ 2 ms)

✅ Fine for v1 low-rate topics (device/alarm/build/asset). Marginal for v2 1 kHz sensor streams (known v2 risk).

### TS (Node) — ⚠️ Gate finding
`@eclipse-zenoh/zenoh-ts@1.9.0` `Config` source comment:

> Currently this can be only the address of **zenohd remote-api plugin websocket**. `<proto>` can be `ws` and `wss` only.

So zenoh-ts **is NOT a native Node peer**. It is a **WebSocket client to a `zenohd` router running the `zenoh-plugin-remote-api`**. `new Config()` with no locator crashes (`open` → `locator.split` on undefined). `Config` has only a `locator` field — no `insert_json5` / listen / connect; you must point it at a router WS endpoint.

**Implication**: the "全 Zenoh" decision forces a **zenohd router process** (with remote-api plugin) whenever the TS studio participates. Python (and C) can be native peers; TS goes TS → WS → router → peer.

## Gate verdict

zenoh-ts being router-only changes the cost model of "全 Zenoh". Three options:

| Option | Local TS↔Python | TS↔remote | Cost |
|---|---|---|---|
| **A. Router-based Zenoh** | TS→WS→zenohd→Python | zenohd + TS WS | router process + WS hop latency |
| **B. Hybrid bus** | **Node IPC / JSON-RPC** (Python brain = supervised subprocess, VSCode-extension-style) | Zenoh (python/c/native) for peer + remote (Tailscale) | lightest local; Zenoh where it shines |
| **C. Native Node binding** | TS native peer | same | community/unmaintained zenoh-c N-API wrappers — risky |

## Recommendation

**B (Hybrid)**. Reasons:
1. VSCode-model already has Python brain as a **supervised single subprocess** of the TS base → parent↔child Node IPC is the natural, fastest, simplest seam (no router, no WS hop).
2. Zenoh stays for the parts that are genuinely peer/distributed: OpenOCD as an embodied-agent peer, future sim modules, **remote (Tailscale)** access. Python↔Python and Python↔C are native peers (measured: 4 ms RTT).
3. Avoids running a zenohd router for the common local-only case.

This **partially revises decision #9** ("全 Zenoh") → "Zenoh for peer/remote; Node IPC for TS↔local-Python." uORB topic model still spans both (the TS↔Python IPC carries the same uORB messages).

## Still to measure (post-decision)

- Python ↔ C (native peer) RTT — expected similar to Py↔Py.
- Throughput with realistic payloads (asset blobs, sim state) — for v2.

## Pending the user's call on A vs B vs C before proceeding to build-task #3.
