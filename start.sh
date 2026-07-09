#!/usr/bin/env bash
# Flux Studio — complete startup (vLLM + Flux-Insight + studio + optional real board)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

RED='\033[0;31m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}[flux]${NC} $*"; }

MODEL_PATH="${FLUX_MODEL_PATH:-/home/exuber/.cache/modelscope/models/OpenBMB--MiniCPM-V-4.6/snapshots/master}"
MODEL_VENV="${FLUX_MODEL_VENV:-$ROOT/../model-server/.venv}"
BRAIN_VENV="${FLUX_BRAIN_VENV:-$ROOT/brain/.venv}"
FLUXMEME_PATH="${FLUXMEME_PATH:-/home/exuber/CORE/CORE27/FLUXmeme/python}"
FLUX_INSIGHT_DIR="${FLUX_INSIGHT_DIR:-/home/exuber/CORE/CORE27/Flux-Insight}"
OPENOCD_REAL="${FLUX_OPENOCD_REAL:-0}"

log "Checking prerequisites..."
[ -f "$MODEL_PATH/config.json" ] || { echo "MiniCPM-V model not found"; exit 1; }
[ -d "$MODEL_VENV" ] || { echo "model-server venv not found"; exit 1; }
[ -d "$BRAIN_VENV" ] || { echo "brain venv not found"; exit 1; }
log "✓ Prerequisites OK"

# ── 1. Start vLLM (MiniCPM-V 4.6) ──
if timeout 2 bash -c '</dev/tcp/127.0.0.1/8000' 2>/dev/null; then
  log "vLLM already running on :8000 (skip)"
else
  log "Starting vLLM (MiniCPM-V 4.6) on :8000..."
  export CUDA_HOME=/usr/local/cuda-13.0
  export PATH="$CUDA_HOME/bin:$PATH"
  export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
  export FLASHINFER_DISABLE_VERSION_CHECK=1
  "$MODEL_VENV/bin/vllm" serve "$MODEL_PATH" \
    --port 8000 --dtype auto --max-model-len 4096 --gpu-memory-utilization 0.7 \
    --trust-remote-code --enforce-eager > /tmp/flux-vllm.log 2>&1 &
  log "vLLM PID: $! — waiting (up to 120s)..."
  for i in $(seq 1 24); do
    sleep 5
    if timeout 2 bash -c '</dev/tcp/127.0.0.1/8000' 2>/dev/null; then
      log "✓ vLLM ready"; break
    fi
    [ $i -eq 24 ] && { echo "vLLM failed (check /tmp/flux-vllm.log)"; exit 1; }
    printf "."
  done
fi

# ── 2. Start Flux-Insight dashboard (:8420) ──
if timeout 2 bash -c '</dev/tcp/127.0.0.1/8420' 2>/dev/null; then
  log "Flux-Insight already running on :8420 (skip)"
else
  if [ -d "$FLUX_INSIGHT_DIR" ]; then
    log "Starting Flux-Insight dashboard on :8420..."
    cd "$FLUX_INSIGHT_DIR"
    python3 run_dashboard.py > /tmp/flux-insight.log 2>&1 &
    log "Flux-Insight PID: $!"
    cd "$ROOT"
    sleep 3
  else
    log "Flux-Insight not found at $FLUX_INSIGHT_DIR (skip)"
  fi
fi

# ── 3. Build app (if needed) ──
[ -f app/out/main/index.js ] || {
  log "Building app..."
  pnpm --filter @fluxworkbench/app build
}

# ── 4. Start Flux Studio ──
log "Starting Flux Studio..."
export FLUX_BRAIN_PY="$BRAIN_VENV/bin/python"
export FLUX_BRAIN_PATH="$ROOT/brain"
export FLUXMEME_PATH
export FLUX_OPENOCD_REAL
export HPM_SDK_BASE="${HPM_SDK_BASE:-/home/exuber/hpm_sdk}"
export GNURISCV_TOOLCHAIN_PATH="${GNURISCV_TOOLCHAIN_PATH:-/opt/riscv}"

if [ "$OPENOCD_REAL" = "1" ]; then
  log "Mode: REAL BOARD (HPM6E00)"
  export FLUX_OPENOCD_BIN="${FLUX_OPENOCD_BIN:-/tmp/hpm-openocd/src/openocd}"
else
  log "Mode: MOCK (no hardware)"
fi

unset ELECTRON_RUN_AS_NODE 2>/dev/null || true
env -u ELECTRON_RUN_AS_NODE \
  pnpm --filter @fluxworkbench/app dev -- --disable-gpu --no-sandbox 2>&1 | tee /tmp/flux-studio.log
