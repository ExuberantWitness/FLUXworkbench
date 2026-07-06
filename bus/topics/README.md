# uORB topic schemas

Typed pub/sub topics (PX4-uORB semantics) carried over Zenoh. Schemas in protobuf;
codegen to TS / C / Python in build-task #2 (Zenoh spike).

- **Zenoh key**: `flux/<workspace>/<domain>/<subject>` (e.g. `flux/default/device/attached`)
- **Semantics**: latest-only (state, default) | queued (events); multi-subscriber
- **Capability gate**: every pub/sub checked against the module's signed manifest

## v1 topic set (see device.proto for message shapes)

| Topic | Direction | Publisher → Subscriber |
|---|---|---|
| `device.attached` | event | OpenOCD → kernel / agent / UI |
| `device.detached` | event | OpenOCD → kernel / agent / UI |
| `alarm.critical` | event (priority 90) | any → kernel (preempts) |
| `alarm.policy-violation` | event | kernel → UI |
| `build.progress` | state | build-task → UI |
| `build.diagnostic` | event | build-task → UI (Problems panel) |
| `openocd.event` | event | OpenOCD → UI |
| `cmd.flash` / `cmd.halt` / `cmd.mdw` | command | agent/UI → OpenOCD (capability: touch-hardware) |
| `agent.event` | event | agent → UI |
| `asset.committed` | event | devready → UI / agent |
| `asset.search` | query | agent → asset module |
| `run.state` | state | kernel → UI |

Add topics here as modules are wired.
