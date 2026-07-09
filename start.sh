#!/usr/bin/env bash
# Flux Studio — non-blocking startup (vLLM starts in background, studio starts immediately)
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

CYAN='\033[0;36m'; NC='\033[0m'
log() { echo -e "${CYAN}[flux]${NC} $*"; }

MODEL_PATH="${FLUX_MODEL_PATH:-/home/exuber/.cache/modelscope/models/OpenBMB--MiniCPM-V-4.6/snapshots/master}"
MODEL_VENV="${FLUX_MODEL_VENV:-$ROOT/../model-server/.venv}"
BRAIN_VENV="${FLUX_BRAIN_VENV:-$ROOT/brain/.venv}"
FLUXMEME_PATH="${FLUXMEME_PATH:-/home/exuber/CORE/CORE27/FLUXmeme/python}"

# ── 1. vLLM (background, non-blocking) ──
if timeout 2 bash -c '</dev/tcp/127.0.0.1/8000' 2>/dev/null; then
  log "vLLM already running ✓"
else
  log "Starting vLLM in background (will be ready in ~60s)..."
  export CUDA_HOME=/usr/local/cuda-13.0
  export PATH="$CUDA_HOME/bin:$PATH"
  export LD_LIBRARY_PATH="$CUDA_HOME/lib64:${LD_LIBRARY_PATH:-}"
  export FLASHINFER_DISABLE_VERSION_CHECK=1
  "$MODEL_VENV/bin/vllm" serve "$MODEL_PATH" \
    --port 8000 --dtype auto --max-model-len 4096 --gpu-memory-utilization 0.7 \
    --trust-remote-code --enforce-eager > /tmp/flux-vllm.log 2>&1 &
  log "vLLM PID: $! — studio will auto-connect when ready"
fi

# ── 2. Flux-Insight (background, non-blocking) ──
if ! timeout 2 bash -c '</dev/tcp/127.0.0.1/8420' 2>/dev/null; then
  FI_DIR="/home/exuber/CORE/CORE27/Flux-Insight"
  if [ -d "$FI_DIR" ]; then
    log "Starting Flux-Insight dashboard in background..."
    (cd "$FI_DIR" && python3 run_dashboard.py > /tmp/flux-insight.log 2>&1) &
  fi
fi

# ── 3. Build (if needed) ──
[ -f app/out/main/index.js ] || pnpm --filter @fluxworkbench/app build

# ── 4. Start Studio (immediately, don't wait for vLLM) ──
log "Starting Flux Studio NOW..."
export FLUX_BRAIN_PY="$BRAIN_VENV/bin/python"
export FLUX_BRAIN_PATH="$ROOT/brain"
export FLUXMEME_PATH
export HPM_SDK_BASE="${HPM_SDK_BASE:-/home/exuber/hpm_sdk}"
export GNURISCV_TOOLCHAIN_PATH="${GNURISCV_TOOLCHAIN_PATH:-/opt/riscv}"

unset ELECTRON_RUN_AS_NODE 2>/dev/null || true
exec env -u ELECTRON_RUN_AS_NODE \
  pnpm --filter @fluxworkbench/app dev -- --disable-gpu --no-sandbox
