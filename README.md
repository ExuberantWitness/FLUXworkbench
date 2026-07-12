# Flux Workbench v2

> Robot-dev **Claude Code** — a one-stop hardware-R&D studio that **merges and surpasses vendor AI-agent IDEs** (CC Studio, STM32CubeIDE, …). VSCode-like, hardware-enhanced.

> Branch **`v2`** is the active rewrite. `main` preserves the v0 toy (Python flux-runtime + vendored openwork + single-file UI) for history.

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
