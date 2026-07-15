#!/usr/bin/env bash
# Flux Studio desktop launcher — double-click entry, no terminal needed.
# Desktop sessions don't source .bashrc, so node/pnpm (nvm-managed) must be
# resolved here explicitly. Logs to ~/.flux/studio.log.
set -u
REPO="${FLUX_REPO:-/home/exuber/CODE/FLUXworkbench}"
LOG="$HOME/.flux/studio.log"
mkdir -p "$HOME/.flux"
exec >>"$LOG" 2>&1
echo "[launcher] $(date -Is) starting"

# The VSCode/agent shells leak ELECTRON_RUN_AS_NODE=1, which breaks the
# Electron main process (ipcMain undefined). Always launch clean.
unset ELECTRON_RUN_AS_NODE

# In-app USB authorization uses pkexec → needs the desktop session bus/display
# to reach the polkit agent. Backfill them if the launch context stripped them.
[ -z "${XDG_RUNTIME_DIR:-}" ] && export XDG_RUNTIME_DIR="/run/user/$(id -u)"
[ -z "${DBUS_SESSION_BUS_ADDRESS:-}" ] && export DBUS_SESSION_BUS_ADDRESS="unix:path=$XDG_RUNTIME_DIR/bus"
[ -z "${DISPLAY:-}" ] && export DISPLAY=":0"

# Resolve node/pnpm: newest nvm install THAT HAS pnpm (not every version does).
if [ -d "$HOME/.nvm/versions/node" ]; then
  for bin in $(ls -d "$HOME"/.nvm/versions/node/*/bin 2>/dev/null | sort -rV); do
    if [ -x "$bin/pnpm" ]; then
      export PATH="$bin:$PATH"
      break
    fi
  done
fi
export PATH="$HOME/.local/bin:$HOME/.local/share/pnpm:/usr/local/bin:$PATH"
# conda CLI for the in-app terminal (first hit wins)
for c in "$HOME/miniconda3/bin" "$HOME/anaconda3/bin" "$HOME/miniforge3/bin" /opt/conda/bin; do
  [ -d "$c" ] && export PATH="$PATH:$c" && break
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[launcher] pnpm not found on PATH=$PATH"
  command -v notify-send >/dev/null && notify-send "Flux Studio" "pnpm not found — check ~/.flux/studio.log"
  exit 1
fi

# Single instance: don't double-launch the dev server.
if pgrep -f "electron-vite dev" >/dev/null 2>&1; then
  echo "[launcher] studio already running"
  command -v notify-send >/dev/null && notify-send "Flux Studio" "已经在运行中"
  exit 0
fi

cd "$REPO" || { command -v notify-send >/dev/null && notify-send "Flux Studio" "repo not found: $REPO"; exit 1; }
echo "[launcher] node=$(command -v node) pnpm=$(command -v pnpm)"
exec pnpm dev
