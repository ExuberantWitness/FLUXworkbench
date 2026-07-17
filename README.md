# Flux Workbench v2

> Robot-dev **Claude Code** — a one-stop hardware-R&D studio that **merges and surpasses vendor AI-agent IDEs** (CC Studio, STM32CubeIDE, …). VSCode-like, hardware-enhanced.

## ⬇️ Install (one click — nothing else to install)

Grab the installer for your OS from **[Releases](https://github.com/ExuberantWitness/FLUXworkbench/releases/latest)** — the app bundles its own Python runtime, so you do **not** install Python, Node, or conda yourself.

| OS | Download | Run |
|---|---|---|
| **Windows** | `FluxWorkbench-<ver>-win-x64.exe` | double-click → Next → Finish |
| **macOS** (Apple Silicon / Intel) | `…-mac-arm64.dmg` / `…-mac-x64.dmg` | open .dmg → drag to Applications → **right-click → Open** first time |
| **Linux** | `…-linux-x64.AppImage` (self-updating) | `chmod +x` and double-click |
| **Linux (Debian/Ubuntu)** | `…-linux-x64.deb` | `sudo apt install ./…deb` |

First boot comes straight up in **mock/simulation mode** — run the guided device bring-up and build a DevReady asset with **no hardware needed**. Full step-by-step, macOS unsigned-app note, and how heavy SDKs/toolchains install on demand: **[INSTALL.md](INSTALL.md)**.

> Real-hardware probe connection (USB authorize + detect) is **Linux-first** today; mock, simulation, asset, and cross-compile features work on all three OSes.

> Branch **`v2`** is the active rewrite. `main` preserves the v0 toy (Python flux-runtime + vendored openwork + single-file UI) for history.

## 🎬 Tutorials / 视频教程

真实界面演示，全部由 Playwright 驱动真实 Electron 应用自动录制——真界面、真数据、真交互。索引与逐格剧本：**[docs/tutorials/](docs/tutorials/README.md)**

All demos below are recorded by driving the real Electron app with Playwright — real UI, real data, real interaction.

### ⭐ 07 · 内核调度器 — 为什么不是另一个 VSCode　[剧本](docs/tutorials/07-kernel-scheduler.md)
五条 RTOS 优先级带的**实时占用**：低优先级软件任务在跑，硬件告警一响（探针失联），Device 带插队先跑、Agent/构建/资产/后台**全部冻结变红**，告警解除再恢复。VSCode 把命令 FIFO 跑完、没有优先级；这里是**内核调度机制本身**不同——硬件事件抢占软件任务，「硬件不等人」。数据源是内核实发的 `scheduler.state`，非预录动画。
![kernel scheduler demo](docs/tutorials/media/07-kernel-scheduler.gif)

### 01 · PCB → BSP　[剧本](docs/tutorials/01-pcb-to-bsp.md)
贴一个 GitHub 链接 → 自动克隆、解析设计文件（.ioc + 网表）→ 提取 MCU/引脚/外设 → 交互连接图（点器件看它连了哪些引脚）。
![PCB to BSP demo](docs/tutorials/media/01-pcb-to-bsp.gif)

### 02 · 设备上机　[剧本](docs/tutorials/02-device-onboard.md)
真实页检测 → ⚡一键上机：识别探针 + 读序列号 + 找芯片 + 拉寄存器手册（2955 寄存器入库）+ 序列号写进资产。
![device onboard](docs/tutorials/media/02-device-onboard.gif)

### 03 · 真板调通 + 芯片烙印　[剧本](docs/tutorials/03-real-bringup-and-bind.md)
一个按钮，六阶段：识别→入库→计划→验证→沉淀→烙印。真板 NUCLEO-H743，读到 IDCODE `0x20036450`，把 DevReady 记录烙进芯片 Flash。
![real bring-up + bind](docs/tutorials/media/03-real-bringup-and-bind.gif)

### 04 · DevReady 资产　[剧本](docs/tutorials/04-devready-asset.md)
每块调通的板子沉淀成一个自描述 `.flux` 活档案：引脚 / RTOS / 调试记忆 / 官方资料 / 生命记录。
![DevReady asset](docs/tutorials/media/04-devready-asset.gif)

### 05 · 小Flux 助手　[剧本](docs/tutorials/05-desk-pet-guided.md)
右下角桌宠：对话即操作，分类你的意图，高亮该点的控件带你走完流程。
![desk pet](docs/tutorials/media/05-desk-pet-guided.gif)

> **06 · 跨平台一键安装** — [剧本](docs/tutorials/06-install.md)（Windows/macOS/Linux 内嵌运行时，装完即用；此条为纯操作流程，暂未录 GIF）

## What it is

A microkernel studio for physical-AI development, structured as **two cores**:

- **Infrastructure core** — unified `3-axis × 2-resource` scheduler (flow / time / priority × compute / storage), all-process microkernel, capability-signed modules, uORB-over-Zenoh bus. **Hardware-first, agent-assisted** ("硬件不等人").
- **Application core** — four first-class primitives (`subagent` / `loop` / `devready` / `simulation`) + workflow scheduling, all = specializations of the scheduler's `Task`.

Three languages, **VSCode-model** layered (base / execution / tool):

| Tier | Language | Role | Like |
|---|---|---|---|
| **base** | TypeScript | Electron studio (Warp-grade UI, **仿 VSCode 布局**) + **kernel** | VSCode itself |
| **execution (on base)** | Python | AI agent + workflow-flow producer + session/devready | VSCode's Python extension |
| **tool** | C/C++ | OpenOCD / future motor·CAN·SPI (RT, embodied agents) | compiler/debugger VSCode invokes |

## Six pain points solved (v1: ①②④⑤⑥; ③ instrument v2)

| # | Pain | Fix |
|---|---|---|
| ① | CubeMX UI lock-in | peripheral/pin/clock **codegen** (scriptable, agent-driven) |
| ② | Schematic ≠ OCR | **local MiniCPM5** multimodal → netlist + components + signals |
| ③ | Instruments (scope/LA) | SCPI/VISA instrument subagents (**v2**) |
| ④ | Context/asset sprawl | devready asset library + storage scheduling |
| ⑤ | Always-asking-for-approval | **policy gate** autonomy (auto within policy) |
| ⑥ | Physical subagents 2nd-class | OpenOCD etc. as **first-class embodied agents** |

## Repo layout

```
app/            TS studio (Electron + React + Monaco, kernel in main)         [Tier 1 base]
native/openocd/ C tool: OpenOCD TCL-RPC driver (embodied agent)               [Tier 2 tool]
brain/          Python execution: agent / workflow / session / storage / asset [Tier 3 execution]
bus/topics/     uORB typed-topic schemas (protobuf) + Zenoh config             [neutral]
mod-headless/   CLI/TUI mode (peer)
mod-tailscale/  remote broker (Zenoh↔Tailscale, capability-gated)
docs/           architecture.md + adr/* + v2/*
```

## Status

v2 skeleton (this branch). See [`docs/architecture.md`](docs/architecture.md) and [`docs/adr/`](docs/adr/) for the design; the approved plan lives at `~/.claude/plans/plan-cozy-snowflake.md`.

## Run (v2)

This is a pnpm workspace — **use pnpm, not npm** (npm hangs inside workspace packages).

```bash
pnpm install                          # installs app/ deps (electron, react, monaco, vite)
pnpm --filter @fluxworkbench/app dev  # electron-vite dev → opens the studio window
pnpm --filter @fluxworkbench/app build
```

**Gotchas in this environment:**
- `ELECTRON_RUN_AS_NODE` is set by the host → force-unset it or electron runs as plain Node (`require("electron")` returns a path string → `electron.app` undefined):
  ```bash
  env -u ELECTRON_RUN_AS_NODE pnpm --filter @fluxworkbench/app dev
  ```
- No real GPU / virtual display → pass `--disable-gpu --no-sandbox` (optional on a real desktop):
  ```bash
  env -u ELECTRON_RUN_AS_NODE pnpm --filter @fluxworkbench/app dev -- --disable-gpu --no-sandbox
  ```
- `@vitejs/plugin-react` must be **v4** (v6+ needs vite 8). Pinned in app/package.json.

Verified: `electron-vite build` produces `out/{main,preload,renderer}`; `dev` launches a full Electron process tree (8 procs) with the React+Monaco renderer served at `:5173`.

## Release (GitHub Releases + auto-update)

Distribution: **AppImage + deb on GitHub Releases**, built by [`release-v2.yml`](.github/workflows/release-v2.yml).

```bash
# 1. bump the version electron-updater compares against
#    (app/package.json "version")
# 2. tag & push — CI builds and publishes the release
git tag v0.1.1 && git push origin v0.1.1
```

Auto-update (electron-updater, wired in `app/main/index.ts`):
- **AppImage** — checks GitHub Releases on launch, downloads in background, installs on quit.
- **deb** — no self-update (apt semantics); users install the new deb.
- Update check is skipped in dev (`!app.isPackaged`) and on non-AppImage Linux installs.

Local packaging without publishing: `npx electron-builder --linux AppImage --publish never` → `release/`.

*v0 (main): Python flux-runtime + vendored openwork + single-file UI — superseded.*
