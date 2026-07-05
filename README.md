# Flux Workbench

Physical-AI 开发**运行时**（壳）——四原语（Subagent / Loop / Asset / World）+ 协调器。
**Flux 运行时是壳（host）**；openwork 与 Flux-Insight 作为 backend **接入**它，非反过来。

> 设计计划（权威）：`C:\Users\zhang\.claude\plans\witty-growing-dragon.md`

## 架构（谁接入谁）
```
┌──────────────────────── Flux 运行时（壳 · Python + Web UI :8430）────────────────────────┐
│  协调器（多任务多线程）调度四原语：Subagent · Loop · Asset · World                         │
│  ┌───────────── 接入的 backend（皆为 Subagent，统一调度）──────────────┐                  │
│  │  Flux-Insight  研究大脑（Claim-Chain；Loop 的 research/write/debug） │                  │
│  │  openwork      agent 引擎（OpenCode；Loop 的 write/execute）          │                  │
│  └────────────────────────────────────────────────────────────────────┘                  │
│  设备 subagent（OpenOCD 多实例…）· Asset（FLUXmeme .flux）· World（Newton 仿真）            │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```
openwork 的 Electron 不作壳；Flux 运行时 headless 驱动 openwork 的 orchestrator/server。

## 仓库布局
- `apps/` `packages/` — openwork 上游（被 Flux 运行时驱动的 agent 引擎；不作壳）
- `flux-runtime/` — **Flux 运行时核心**（Python；壳）
  - `src/flux_runtime/primitives.py` — 四原语抽象 + 统一 Message/Event 流
  - `src/flux_runtime/coordinator.py` — 多任务多线程调度器（asyncio + 线程池 + 进程池）
  - `src/flux_runtime/subagents/openocd.py` — OpenOCD 设备 subagent（多实例，guideline.md 接地）
  - `src/flux_runtime/backends/flux_insight.py` — **Flux-Insight 接入**（research/query_claims/ingest；:8420）
  - `src/flux_runtime/backends/openwork.py` — **openwork 接入**（agent_run/agent_status；:8431）
  - `src/flux_runtime/mock.py` — 离线 mock subagent（罐装 guideline 真值，免硬件）
  - `src/flux_runtime/server.py` — FastAPI + WebSocket（UI 面）
  - `ui/index.html` — 单文件 Web UI（三区：Subagents / Dispatch+Trace / Live stream）

## 运行时 UI（现在跑）
```powershell
cd E:\DATA\vscode\ARIS\FluxWorkbench\flux-runtime
$env:PYTHONPATH="src"
C:\Users\zhang\.conda\envs\FLUX\python.exe -m flux_runtime
# → 打开 http://127.0.0.1:8430
```
默认两个 mock 设备（hpm-0 / stm32-0，离线 demo）。点 capability chip → Run → 看 trace + 实时流。

### 接入 backend（env 驱动，opt-in）
```powershell
$env:FLUX_FI_ROOT="E:\DATA\vscode\ARIS\Flux-Insight"
$env:FLUX_FI_PYTHON="C:\Users\zhang\.conda\envs\FLUX\python.exe"
$env:FLUX_OPENWORK_ROOT="E:\DATA\vscode\ARIS\FluxWorkbench"
# 再启动 flux_runtime → UI 多出 flux-insight / openwork 两个 Subagent 卡片
```
> backend 的 HTTP 调用是 best-effort（对 live 引擎核实端点后定稿）。Flux-Insight 也可进程内直调（`claim_chain.api.ClaimChainAPI` 已可 import）。

## 基座（openwork fork，已验证可构建）
- ✅ openwork `dev` 浅克隆（>= v0.17.9）→ `flux/main`；`/ee/` Fair-Source 外科切除
- ✅ `pnpm install`（1359 包）+ better-sqlite3 对 Electron 35 ABI 源码重建（`.npmrc` 持久化 python+msvs）
- ✅ UI 构建（Vite 26.8s）
- ⚠️ Bun 装不上（GFW）→ openwork server 走 Node fallback（`apps/server/src/serve-node.ts`）

## 进行中
CAN/serial/camera/VLA/solver/GUI-operator subagent · Loop（Claim-Chain research→execute→debug + ASPIRE）· Asset（FLUXmeme+FluxWeave+PHM）· World（push→sim）· backend HTTP 端点对 live 引擎核实。

## ee-ectomy 清单
`ee/` 删；`pnpm-workspace.yaml` 去 ee globs；`package.json` 去 den/web/headless 脚本（54→37）；
`turbo.json` globalEnv 去 DEN/STRIPE/BETTER_AUTH（22→1）；den/daytona workflows + cloud/daytona evals + packaging/helm 删。

---
*Flux Workbench · 物理 AI 基础设施 · 机器人开发的 Claude Code*
