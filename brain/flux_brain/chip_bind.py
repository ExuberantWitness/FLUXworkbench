"""Chip binding — the 6th golden-path phase: stamp a DevReady record into the
real MCU's non-volatile Flash and read it back, binding asset↔silicon.

Round-trip proven by hand on a NUCLEO-H743 (fingerprint + factory UID written
to the last Flash sector, survived reset). This wraps that as a deterministic
action any board can run when a real probe is attached.

32-byte record @ the board's chosen Flash slot:
  [0:4]   b"FLUX" magic
  [4:12]  devready fingerprint (8 bytes)
  [12:24] chip factory UID (12 bytes / 96-bit, read live)
  [24:28] 0xDE7EAD15 marker
  [28:32] 0xFFFFFFFF pad  (H743 flash word = 32 bytes)
"""
from __future__ import annotations

import os
import re
import struct
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any

from . import asset_store

# Per-family binding parameters: where the factory UID lives (read-only) and a
# safe Flash slot far from the vector table for our record. Verified for H7;
# others are best-effort from reference manuals — a board profile can override.
FAMILY_BIND: dict[str, dict[str, Any]] = {
    "STM32H7": {"uid_addr": 0x1FF1E800, "slot": 0x080E0000, "target": "target/stm32h7x.cfg"},
    "STM32F4": {"uid_addr": 0x1FFF7A10, "slot": 0x080E0000, "target": "target/stm32f4x.cfg"},
    "STM32F7": {"uid_addr": 0x1FF0F420, "slot": 0x081E0000, "target": "target/stm32f7x.cfg"},
    "STM32F1": {"uid_addr": 0x1FFFF7E8, "slot": 0x0801FC00, "target": "target/stm32f1x.cfg"},
    "STM32G4": {"uid_addr": 0x1FFF7590, "slot": 0x0807F800, "target": "target/stm32g4x.cfg"},
    "STM32L4": {"uid_addr": 0x1FFF7590, "slot": 0x080FF800, "target": "target/stm32l4x.cfg"},
}

MAGIC = b"FLUX"
MARKER = 0xDE7EAD15


def _family(chip: str) -> str | None:
    c = chip.upper()
    for pfx in FAMILY_BIND:
        if c.startswith(pfx):
            return pfx
    return None


def _ocd(cfgs: list[str], commands: list[str], search: str = "", timeout: int = 45) -> str:
    """Run one openocd batch, return combined stdout+stderr."""
    args = ["openocd"]
    if search:
        args += ["-s", os.path.expanduser(search)]
    for c in cfgs:
        args += ["-f", c]
    for cmd in commands:
        args += ["-c", cmd]
    try:
        r = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
        return r.stdout + r.stderr
    except FileNotFoundError:
        return "ERROR: openocd not found — install it (apt install openocd) to bind real chips"
    except subprocess.TimeoutExpired:
        return "ERROR: openocd timed out"


def _parse_words(out: str, addr: int, n: int) -> list[int]:
    """Pull `n` 32-bit words printed by `mdw <addr> n` from openocd output."""
    tag = f"0x{addr:08x}"
    for line in out.splitlines():
        if line.strip().lower().startswith(tag):
            hexes = re.findall(r"[0-9a-fA-F]{8}", line.split(":", 1)[1])
            return [int(h, 16) for h in hexes[:n]]
    return []


def verify_chip_live(board: str, boards_json: str) -> dict[str, Any]:
    """Real-board verification WITHOUT firmware: spawn openocd, read the debug
    IDCODE + factory UID, confirm the silicon is alive and matches the profile.
    This is what characterization needs — not a firmware HIL. Independent of the
    bus OpenOcdAgent's mode (spawns its own openocd, like bind_chip)."""
    import json
    try:
        prof = next(b for b in json.load(open(boards_json))["boards"] if b["id"] == board)
    except (OSError, KeyError, StopIteration):
        return {"ok": False, "error": f"unknown board '{board}'"}
    chip = prof.get("chip", "")
    fam = _family(chip)
    ocd = prof.get("openocd", {})
    cfgs = ocd.get("cfgs") or (["interface/stlink.cfg", (FAMILY_BIND.get(fam or "", {}).get("target", ""))])
    cfgs = [c for c in cfgs if c]
    search = ocd.get("search", "")
    # IDCODE reg: STM32 DBGMCU_IDCODE varies by family; H7=0x5C001000, most
    # others 0xE0042000. UID from the family table.
    idcode_addr = 0x5C001000 if (chip.upper().startswith("STM32H7")) else 0xE0042000
    uid_addr = FAMILY_BIND.get(fam or "", {}).get("uid_addr")
    cmds = ["init", "reset halt", f"mdw 0x{idcode_addr:08x} 1"]
    if uid_addr:
        cmds.append(f"mdw 0x{uid_addr:08x} 3")
    cmds.append("shutdown")
    out = _ocd(cfgs, cmds, search)
    if "libusb" in out.lower() and "error" in out.lower():
        return {"ok": False, "error": "probe not authorized — run USB authorize and retry", "detail": out[-200:]}
    idc = _parse_words(out, idcode_addr, 1)
    uid = _parse_words(out, uid_addr, 3) if uid_addr else []
    idcode = idc[0] if idc else 0
    uid_hex = "".join(f"{w:08x}" for w in uid) if uid else ""
    alive = idcode != 0 and (not uid_addr or any(uid))
    return {
        "ok": alive, "chip": chip, "idcode": f"0x{idcode:08x}", "uid": uid_hex,
        "device_id": f"0x{idcode & 0xFFF:03x}",
        "note": "silicon alive, debug link up, UID read" if alive
                else "reads returned 0 — probe not connected or target not halted",
    }


def bind_chip(board: str, boards_json: str, iface_cfgs: list[str] | None = None,
              search: str = "", dry_run: bool = False) -> dict[str, Any]:
    """Read UID, write the DevReady record to Flash, read it back, and stamp the
    live UID into the devready asset. Requires a real probe + openocd."""
    import json
    try:
        prof = next(b for b in json.load(open(boards_json))["boards"] if b["id"] == board)
    except (OSError, KeyError, StopIteration):
        return {"error": f"unknown board '{board}'"}
    chip = prof.get("chip", "")
    fam = _family(chip)
    if not fam:
        return {"error": f"chip binding not defined for {chip} (family unknown) — "
                         "add it to FAMILY_BIND or the board profile"}
    bind = {**FAMILY_BIND[fam], **prof.get("bind", {})}
    ocd = prof.get("openocd", {})
    cfgs = (iface_cfgs or ocd.get("cfgs")) or ["interface/stlink.cfg", bind["target"]]
    search = search or ocd.get("search", "")

    dr = asset_store.get_asset(f"devready-{board}")
    if not dr:
        return {"error": f"no devready asset for {board} — compose it first"}
    fp = dr.get("identity", {}).get("fingerprint", "")
    if len(fp) < 16:
        fp = (fp + "0" * 16)[:16]

    uid_addr, slot = bind["uid_addr"], bind["slot"]

    # 1. read the factory UID (also proves we can talk to the chip)
    out = _ocd(cfgs, ["init", "reset halt", f"mdw 0x{uid_addr:08x} 3", "shutdown"], search)
    if "ERROR:" in out or "Error:" in out and "libusb" in out:
        return {"error": "cannot reach the chip — authorize the probe (USB) and retry",
                "detail": out[-300:]}
    uid = _parse_words(out, uid_addr, 3)
    if len(uid) != 3:
        return {"error": "could not read chip UID — is the board halted/connected?",
                "detail": out[-300:]}
    uid_hex = "".join(f"{w:08x}" for w in uid)

    if dry_run:
        return {"board": board, "chip": chip, "uid": uid_hex, "slot": f"0x{slot:08x}",
                "fingerprint": fp, "dry_run": True,
                "note": "would erase the last Flash sector and write a 32-byte record here"}

    # 2. build the 32-byte record and flash it
    rec = (MAGIC + bytes.fromhex(fp)
           + struct.pack("<III", *uid)
           + struct.pack("<I", MARKER) + b"\xFF\xFF\xFF\xFF")
    assert len(rec) == 32
    with tempfile.NamedTemporaryFile(suffix=".bin", delete=False) as f:
        f.write(rec); recfile = f.name
    try:
        out = _ocd(cfgs, ["init", "reset halt",
                          f"flash write_image erase {recfile} 0x{slot:08x}",
                          "reset halt", f"mdw 0x{slot:08x} 8", "shutdown"], search, timeout=60)
    finally:
        os.unlink(recfile)
    if "wrote 32 bytes" not in out and "programmed" not in out.lower():
        return {"error": "flash write did not confirm", "detail": out[-400:]}

    # 3. read-back verify (post-reset words) — proves persistence
    words = _parse_words(out, slot, 8)
    ok = len(words) >= 7 and words[0] == 0x58554c46  # little-endian "FLUX"
    readback = "".join(f"{w:08x}" for w in words)

    # 4. stamp the live UID + Flash slot back into the devready asset
    if ok:
        dr.setdefault("identity", {})
        dr["identity"]["chip_uid"] = uid_hex
        dr["identity"]["flash_slot"] = f"0x{slot:08x}"
        dr["identity"]["bound_at"] = time.strftime("%Y-%m-%d %H:%M")
        dr.setdefault("health", {})["bound"] = True
        asset_store.commit_asset(dr)

    return {"board": board, "chip": chip, "uid": uid_hex, "fingerprint": fp,
            "slot": f"0x{slot:08x}", "verified": ok, "readback": readback,
            "asset_updated": ok,
            "note": "DevReady record persisted to Flash + chip UID stamped into asset"
                    if ok else "readback mismatch — record may not have persisted"}
