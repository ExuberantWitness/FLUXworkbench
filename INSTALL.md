# Installing FluxWorkbench

**One click. Nothing else to install.** The installer bundles everything the
studio needs to boot — including its own Python runtime. You do **not** need to
install Python, Node, conda, or any dependency yourself.

Download the installer for your OS from the
[Releases page](https://github.com/ExuberantWitness/FLUXworkbench/releases/latest).

| OS | File | How |
|---|---|---|
| **Windows** | `FluxWorkbench-<ver>-win-x64.exe` | Double-click → Next → Finish. Launches automatically. |
| **macOS (Apple Silicon)** | `FluxWorkbench-<ver>-mac-arm64.dmg` | Open the .dmg, drag to Applications. First launch: **right-click → Open** (see note). |
| **macOS (Intel)** | `FluxWorkbench-<ver>-mac-x64.dmg` | Same as above. |
| **Linux** | `FluxWorkbench-<ver>-linux-x64.AppImage` | `chmod +x` it and double-click, or `./FluxWorkbench-*.AppImage`. |
| **Linux (Debian/Ubuntu)** | `FluxWorkbench-<ver>-linux-x64.deb` | `sudo apt install ./FluxWorkbench-*.deb` |

On first boot the studio verifies its embedded runtime and comes straight up in
**mock/simulation mode** — you can run the guided device bring-up, build a
DevReady asset, and explore everything without any hardware.

## macOS: first-launch note (unsigned build)

The app is not notarized (no paid Apple Developer account yet), so Gatekeeper
blocks the first open. Two ways past it:

- **Right-click the app → Open → Open** (only needed once), **or**
- Terminal: `xattr -dr com.apple.quarantine /Applications/FluxWorkbench.app`

## What's included vs. installed on demand

**In the installer (works offline, immediately):** the UI + kernel, the Python
brain + its runtime, mock probe, board profiles, examples, the simulation stack
config, and DevReady asset tooling.

**Installed from inside the app, only when you need real hardware:** vendor SDKs
(e.g. HPM SDK), cross-compile toolchains, a board-specific OpenOCD, NVIDIA Isaac
Sim. The studio walks you through these one-click, per board — nothing heavy is
forced into the download.

## Platform notes for real-hardware features

Connecting a **real** debug probe is currently **Linux-first**: USB
authorization uses the Linux `pkexec`/`udev` mechanism, and device detection
uses `lsusb`. On Windows and macOS these controls are disabled with an
explanation; **mock, simulation, asset, and cross-compile features work on all
three platforms.**

## Auto-update

The Linux **AppImage** updates itself in the background via GitHub Releases.
Windows and macOS: download the newer installer from the Releases page (in-app
update for these is on the roadmap).

## Building installers yourself

```bash
pnpm install
node scripts/fetch-python.mjs   # embed CPython for your OS (once)
pnpm -r build
npx electron-builder --linux    # or --win / --mac
# output in release/
```
CI (`.github/workflows/release.yml`) builds all three on tag push (`v*`).
