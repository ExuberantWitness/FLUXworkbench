"""HPM6E00 cross-compile build-task — calls riscv GCC + HPM_SDK + CMake.

Produces demo.elf + demo.bin for flashing via OpenOCD.
Env: GNURISCV_TOOLCHAIN_PATH=/opt/riscv, HPM_SDK_BASE=/home/exuber/hpm_sdk
"""
from __future__ import annotations
import os, subprocess, shutil
from pathlib import Path

TOOLCHAIN = os.environ.get("GNURISCV_TOOLCHAIN_PATH", "/opt/riscv")
SDK = os.environ.get("HPM_SDK_BASE", "/home/exuber/hpm_sdk")
BOARD = "hpm6e00evk"


def build(sample_dir: str, build_dir: str = "/tmp/flux-build") -> dict:
    """Build an HPM_SDK sample for HPM6E00. Returns {elf, bin, ok}."""
    shutil.rmtree(build_dir, ignore_errors=True)
    Path(build_dir).mkdir(parents=True)
    env = {**os.environ, "GNURISCV_TOOLCHAIN_PATH": TOOLCHAIN, "HPM_SDK_BASE": SDK,
           "PATH": f"{TOOLCHAIN}/bin:{os.environ['PATH']}"}
    subprocess.run(["cmake", "-DBOARD", BOARD, "-DHPM_SDK_BASE", SDK, sample_dir],
                   cwd=build_dir, env=env, check=True, capture_output=True)
    subprocess.run(["make", "-j4"], cwd=build_dir, env=env, check=True, capture_output=True)
    elf = Path(build_dir) / "output" / "demo.elf"
    binf = Path(build_dir) / "output" / "demo.bin"
    return {"elf": str(elf), "bin": str(binf), "ok": elf.exists()}
