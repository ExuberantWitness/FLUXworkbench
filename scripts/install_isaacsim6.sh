#!/usr/bin/env bash
# Isaac Sim 6.0 + Isaac Lab one-click installer — non-interactive, stream-friendly.
#
# Adapted from the robotsfan oneclick flow (docs.robotsfan.com/install_isaaclab.sh)
# with every prompt replaced by env vars, so the studio can run it as a
# kernel-scheduled task and tail the [STEP]/[OK]/[WARN]/[ERR] markers.
#
#   FLUX_ISAAC_ROOT      install root        (default ~/isaacsim6)
#   FLUX_ISAAC_PY        python version      (default 3.11)
#   FLUX_ISAACSIM_VER    isaacsim pip pin    (default: newest 6.x on pypi.nvidia.com)
#   FLUX_ISAACLAB_REF    IsaacLab git ref    (default: main)
#   FLUX_SKIP_ISAACLAB   set 1 to install Isaac Sim only
set -uo pipefail

STEP() { echo "[STEP] $*"; }
OK()   { echo "[OK] $*"; }
WARN() { echo "[WARN] $*"; }
ERR()  { echo "[ERR] $*" >&2; }

ROOT="${FLUX_ISAAC_ROOT:-$HOME/isaacsim6}"
PYVER="${FLUX_ISAAC_PY:-3.12}"  # isaacsim 6.x ships cp312 wheels only
SIMVER="${FLUX_ISAACSIM_VER:-}"
LABREF="${FLUX_ISAACLAB_REF:-main}"
VENV="$ROOT/.venv"

# ── 1/7 NVIDIA GPU + driver ─────────────────────────────────────────────────
STEP "1/7 checking NVIDIA GPU"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  ERR "nvidia-smi not found — Isaac Sim 6.0 requires an NVIDIA RTX GPU"
  exit 1
fi
nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader | sed 's/^/[OK] gpu: /'
DRV_MAJOR=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader | head -1 | cut -d. -f1)
if [ "${DRV_MAJOR:-0}" -ge 580 ]; then
  OK "driver ${DRV_MAJOR}.x meets the 6.0 recommendation (>=580)"
elif [ "${DRV_MAJOR:-0}" -ge 535 ]; then
  WARN "driver ${DRV_MAJOR}.x may run but 6.0 features expect >=580 — consider upgrading"
else
  ERR "driver ${DRV_MAJOR:-unknown} too old (<535)"
  exit 1
fi

# ── 2/7 OS / GLIBC ──────────────────────────────────────────────────────────
STEP "2/7 checking OS"
OSREL=$(lsb_release -rs 2>/dev/null || echo unknown)
case "$OSREL" in
  22.04|24.04) OK "Ubuntu $OSREL (officially supported)" ;;
  *) WARN "Ubuntu $OSREL is not in the officially supported list (22.04/24.04)" ;;
esac
GLIBC=$(ldd --version | head -1 | grep -oE '[0-9]+\.[0-9]+$' || echo 0)
OK "glibc $GLIBC"

# ── 3/7 uv + venv ───────────────────────────────────────────────────────────
STEP "3/7 python $PYVER venv at $VENV (uv)"
command -v uv >/dev/null 2>&1 || { ERR "uv not found (install: curl -LsSf https://astral.sh/uv/install.sh | sh)"; exit 1; }
mkdir -p "$ROOT"
[ -d "$VENV" ] || uv venv --python "$PYVER" --seed "$VENV" || { ERR "venv creation failed"; exit 1; }
PIP=(uv pip install --python "$VENV/bin/python")
OK "venv ready"

# ── 4/7 Isaac Sim from NVIDIA pypi ──────────────────────────────────────────
STEP "4/7 installing Isaac Sim ${SIMVER:-latest 6.x} (pypi.nvidia.com — ~10GB, be patient)"
SIM_SPEC="isaacsim[all,extscache]"
[ -n "$SIMVER" ] && SIM_SPEC="isaacsim[all,extscache]==${SIMVER}"
if ! "${PIP[@]}" "$SIM_SPEC" --extra-index-url https://pypi.nvidia.com --index-strategy unsafe-best-match --prerelease=allow 2>&1 | tail -3; then
  ERR "isaacsim install failed — check network / available versions:"
  "$VENV/bin/pip" index versions isaacsim --extra-index-url https://pypi.nvidia.com 2>/dev/null || true
  exit 1
fi
OK "isaacsim installed"

# ── 5/7 Isaac Lab ───────────────────────────────────────────────────────────
if [ "${FLUX_SKIP_ISAACLAB:-0}" != "1" ]; then
  STEP "5/7 Isaac Lab ($LABREF)"
  if [ ! -d "$ROOT/IsaacLab" ]; then
    git clone --depth 1 -b "$LABREF" https://github.com/isaac-sim/IsaacLab.git "$ROOT/IsaacLab" || { ERR "IsaacLab clone failed"; exit 1; }
  fi
  # isaaclab.sh prefers CONDA_PREFIX over VIRTUAL_ENV — shed any resident conda
  ( cd "$ROOT/IsaacLab" && unset CONDA_PREFIX CONDA_DEFAULT_ENV PYTHONPATH \
      && source "$VENV/bin/activate" && ./isaaclab.sh --install 2>&1 | tail -5 ) \
    && OK "IsaacLab installed" || { ERR "isaaclab.sh --install failed"; exit 1; }
else
  STEP "5/7 skipped (FLUX_SKIP_ISAACLAB=1)"
fi

# ── 6/7 Isaac Sim Skills / MCP hookup hint ──────────────────────────────────
STEP "6/7 Isaac Sim Skills (MCP)"
if "$VENV/bin/python" - <<'EOF' 2>/dev/null
import importlib.util
import sys
sys.exit(0 if importlib.util.find_spec("isaacsim") else 1)
EOF
then
  OK "to attach the Isaac Sim MCP/Skills server to Flux Studio, set:"
  echo "     FLUX_ISAACSIM_MCP=\"$VENV/bin/python -m isaacsim.mcp_server\"  (adjust to the shipped entrypoint)"
else
  WARN "isaacsim import probe failed"
fi

# ── 7/7 verification ────────────────────────────────────────────────────────
STEP "7/7 headless smoke (SimulationApp import)"
if "$VENV/bin/python" -c "from isaacsim import SimulationApp; print('SimulationApp import OK')" 2>&1 | tail -1; then
  OK "Isaac Sim 6 install verified — root: $ROOT"
else
  WARN "import verification failed — first launch may still need EULA/env setup"
fi
echo "[DONE] isaac install finished"
