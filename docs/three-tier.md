# Three-Tier Architecture (TS 主 + Python 执行 + C 工具)

> Plan decision #10; see also ADR 0002 for the hybrid bus revision.

## Layering (VSCode model)

| Tier | Role | Language | Analogy |
|---|---|---|---|
| **base** | Electron host + Warp UI + kernel | TypeScript | VSCode itself |
| **execution** | AI agent + workflow flow + session/asset | Python (single proc) | VSCode Python extension |
| **tool** | OpenOCD + future motor/CAN/SPI | C/C++ (subprocess) | compiler/debugger VSCode invokes |

## Orchestration boundary (decision #20)

- **Python produces flow** (workflow DAG: what to do, order)
- **TS scheduler dispatches** along flow + time + priority to compute/storage
- Python does NOT dispatch; TS does.

## Data flow (live vertical)

```
TS kernel boot
  → spawn Python brain (Node IPC)
  → spawn OpenOCD agent (subprocess: mock or real HPM OpenOCD)
  → OpenOCD publishes device.attached
  → brain publishes workflow.published (DAG)
  → kernel WorkflowRunner dispatches cmd.* steps in topo order
  → OpenOCD executes flash/halt → publishes openocd.event
  → brain reacts: policy_gate check → flywheel search → MiniCPM-V characterize
    + codegen → asset.committed (with Session lineage)
  → kernel alarm demo: publishes alarm.critical (p90)
  → renderer: Monaco editor + event stream + agent chat + status bar
```

## Purity guarantee

Hardware control path = TS kernel + C OpenOCD, does NOT require Python.
If brain crashes, OpenOCD agent still handles flash/halt/mdw.
