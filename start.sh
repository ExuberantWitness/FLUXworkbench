#!/usr/bin/env bash
# Flux Workbench — one-click start script.
# Launches: vLLM (MiniCPM-V 4.6) + Electron studio.
# Prerequisites: see README.md "Quick Start" section.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── Colors ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}[flux]${NC} $*"; }
warn() { echo -e "${YELLOW}[flux]${NC} $*"; }
err() { echo -e "${RED}[flux]${NC} $*" >&2; }

# ── Config (override via env) ───────────────────────────────────────────────
MODEL_PATH="${FLUX_MODEL_PATH:-/home/exuber/.cache/modelscope/models/OpenBMB--MiniCPM-V-4.6/snapshots/master}"
MODEL_VENV="${FLUX_MODEL_VENV:-$ROOT/../model-server/.venv}"
BRAIN_VENV="${FLUX_BRAIN_VENV:-$ROOT/brain/.venv}"
OPENOCD_REAL="${FLUX_OPENOCD_REAL:-0}"
OPENOCD_BIN="${FLUX_OPENOCD_BIN:-/tmp/hpm-openocd/src/openocd}"
HPM_SDK_BASE="${HPM_SDK_BASE:-/home/exuber/hpm_sdk}"
VLLM_PORT="${FLUX_VLLM_PORT:-8000}"

# ── Checks ──────────────────────────────────────────────────────────────────
log "Checking prerequisites..."

check() { command -v "$1" >/dev/null 2>&1 || { err "missing: $1"; return 1; }; }

check node || exit 1
check pnpm || { err "pnpm not found — install: npm i -g pnpm"; exit 1; }
[ -f "$MODEL_PATH/config.json" ] || { err "MiniCPM-V model not found at $MODEL_PATH"; exit 1; }
[ -d "$MODEL_VENV" ] || { err "model-server venv not found at $MODEL_VENV"; exit 1; }
[ -d "$BRAIN_VENV" ] || { err "brain venv not found at $BRAIN_VENV"; exit 1; }

log "✓ Prerequisites OK"

# ── 1. Start vLLM (if not already running) ─────────────────────────────────
if timeout 2 bash -c "</dev/tcp/127.0.0.1/$VLLM_PORT" 2>/dev/null; then
  log "vLLM already running on :$VLLM_PORT (skipping)"
else
  log "Starting vLLM (MiniCPM-V 4.6) on :$VLLM_PORT..."
  export CUDA_HOME=/usr/local/cuda-13.0
  export PATH="$CUDA_HOME/bin:$PATH"
  export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
  export FLASHINFER_DISABLE_VERSION_CHECK=1

  "$MODEL_VENV/bin/vllm" serve "$MODEL_PATH" \
    --port "$VLLM_PORT" --dtype auto --max-model-len 4096 \
    --gpu-memory-utilization 0.7 --trust-remote-code --enforce-eager \
    > /tmp/flux-vllm.log 2>&1 &
  VLLM_PID=$!
  log "vLLM PID: $VLLM_PID — waiting for startup (up to 120s)..."

  for i in $(seq 1 24); do
    sleep 5
    if timeout 2 bash -c "</dev/tcp/127.0.0.1/$VLLM_PORT" 2>/dev/null; then
      log "✓ vLLM ready on :$VLLM_PORT"
      break
    fi
    [ $i -eq 24 ] && { err "vLLM failed to start (check /tmp/flux-vllm.log)"; exit 1; }
    printf "."
  done
fi

# ── 2. Start Electron studio ────────────────────────────────────────────────
log "Starting Flux Workbench studio..."

# Build first (if needed)
[ -f app/out/main/index.js ] || {
  log "Building app..."
  pnpm --filter @fluxworkbench/app build
}

# Launch
export FLUX_BRAIN_PY="$BRAIN_VENV/bin/python"
export FLUX_BRAIN_PATH="$ROOT/brain"
export FLUX_OPENOCD_REAL="$OPENOCD_REAL"
export FLUX_OPENOCD_BIN="$OPENOCD_BIN"
export HPM_SDK_BASE="$HPM_SDK_BASE"

if [ "$OPENOCD_REAL" = "1" ]; then
  log "OpenOCD mode: REAL (HPM6E00 board)"
else
  log "OpenOCD mode: MOCK (no hardware needed)"
fi

# Electron needs ELECTRON_RUN_AS_NODE unset
unset ELECTRON_RUN_AS_NODE 2>/dev/null || true

env -u ELECTRON_RUN_AS_NODE \
  pnpm --filter @fluxworkbench/app dev -- --disable-gpu --no-sandbox 2>&1 | tee /tmp/flux-studio.log

# ── Cleanup on exit ─────────────────────────────────────────────────────────
if [ -n "${VLLM_PID:-}" ]; then
  log "Stopping vLLM (PID $VLLM_PID)..."
  kill "$VLLM_PID" 2>/dev/null || true
fi
log "Flux Workbench stopped."
