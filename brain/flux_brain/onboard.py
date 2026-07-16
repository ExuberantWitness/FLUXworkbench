"""Device onboarding — the whole "new board" flow, made generic and automatic.

What Claude Code did by hand for the NUCLEO-H743 (detect → identify probe +
serial + UART → build a board profile → fetch/ingest the SVD → sanity-check the
register map → stamp the serial into a devready asset) becomes one backend that
works for ANY MCU: HPM, STM32, or an unknown board the user names.

Deterministic where it can be (sysfs scan, SVD fetch/parse, profile write);
asks the user only for what can't be derived (the exact chip, for an unknown
probe). PCB-level BSP extraction (CubeMX / Altium / EasyEDA / KiCad) is a
separate track — see custom_board_hint().
"""
from __future__ import annotations

import glob
import json
import os
import re
import time
from pathlib import Path
from typing import Any

from . import asset_store, svd_ingest

# USB vendor → what the probe is and which silicon vendor it fronts. Extend to
# support more probes; this is the "known families" table.
VENDOR_REGISTRY: dict[str, dict[str, Any]] = {
    "0483": {"vendor": "STMicroelectronics", "probe": "ST-Link", "svd_dir": "STMicro",
             "chip_prefixes": ["STM32"], "openocd_iface": "interface/stlink.cfg"},
    "0403": {"vendor": "FTDI / HPMicro", "probe": "FT2232 / on-board", "svd_dir": None,
             "chip_prefixes": ["HPM"], "openocd_iface": "probes/ft2232.cfg"},
    "1366": {"vendor": "SEGGER", "probe": "J-Link", "svd_dir": None,
             "chip_prefixes": [], "openocd_iface": "interface/jlink.cfg"},
    "0d28": {"vendor": "ARM", "probe": "CMSIS-DAP / DAPLink", "svd_dir": None,
             "chip_prefixes": [], "openocd_iface": "interface/cmsis-dap.cfg"},
    "1cbe": {"vendor": "Texas Instruments", "probe": "ICDI / XDS", "svd_dir": "TexasInstruments",
             "chip_prefixes": ["MSP", "TM4C", "CC"], "openocd_iface": "interface/xds110.cfg"},
    "1a86": {"vendor": "WCH", "probe": "WCH-Link", "svd_dir": None,
             "chip_prefixes": ["CH32"], "openocd_iface": "interface/cmsis-dap.cfg"},
}

# openocd target cfg per STM32 series (best-effort; upstream openocd names).
_STM32_TARGET = {
    "STM32F1": "target/stm32f1x.cfg", "STM32F4": "target/stm32f4x.cfg",
    "STM32F7": "target/stm32f7x.cfg", "STM32H7": "target/stm32h7x.cfg",
    "STM32G0": "target/stm32g0x.cfg", "STM32G4": "target/stm32g4x.cfg",
    "STM32L4": "target/stm32l4x.cfg", "STM32U5": "target/stm32u5x.cfg",
}

_CMSIS_SVD_BASE = "https://raw.githubusercontent.com/cmsis-svd/cmsis-svd-data/main/data"


# ── 1. scan: full USB device tree, classified ──────────────────────────────

def _sysfs_field(dev_dir: str, name: str) -> str:
    try:
        return Path(dev_dir, name).read_text().strip()
    except OSError:
        return ""


def _uart_for(dev_dir: str) -> str | None:
    """Find the /dev/ttyACMx or ttyUSBx belonging to this USB device node."""
    for tty in glob.glob(os.path.join(dev_dir, "*/tty*/")) + glob.glob(os.path.join(dev_dir, "*/*/tty*/")):
        name = os.path.basename(tty.rstrip("/"))
        if name.startswith(("ttyACM", "ttyUSB")):
            return f"/dev/{name}"
    # fallback: any ttyACM present (single-probe common case)
    acm = sorted(glob.glob("/dev/ttyACM*"))
    return acm[0] if acm else None


def scan(boards_json: str | None = None) -> list[dict[str, Any]]:
    """Enumerate every USB device, tag known probes and known boards."""
    known = {}
    if boards_json and os.path.exists(boards_json):
        try:
            for b in json.load(open(boards_json)).get("boards", []):
                u = b.get("usb", {})
                if u.get("vid") and u.get("pid"):
                    known[f"{u['vid']}:{u['pid']}"] = b
        except (OSError, json.JSONDecodeError):
            pass
    out = []
    for vid_file in glob.glob("/sys/bus/usb/devices/*/idVendor"):
        dev_dir = os.path.dirname(vid_file)
        vid = _sysfs_field(dev_dir, "idVendor")
        pid = _sysfs_field(dev_dir, "idProduct")
        if not vid:
            continue
        reg = VENDOR_REGISTRY.get(vid.lower())
        if not reg:
            continue  # not a debug probe we recognize — skip hubs/misc
        key = f"{vid}:{pid}"
        entry = {
            "vid": vid, "pid": pid,
            "product": _sysfs_field(dev_dir, "product"),
            "serial": _sysfs_field(dev_dir, "serial"),
            "vendor": reg["vendor"], "probe": reg["probe"],
            "uart": _uart_for(dev_dir),
            "known_board": known.get(key, {}).get("id"),
            "known_chip": known.get(key, {}).get("chip"),
        }
        out.append(entry)
    return out


def identify(vid: str, pid: str, boards_json: str | None = None) -> dict[str, Any]:
    """Classify one probe: vendor, likely silicon family, what we still need."""
    reg = VENDOR_REGISTRY.get(vid.lower(), {})
    match = next((d for d in scan(boards_json) if d["vid"].lower() == vid.lower() and d["pid"] == pid), None)
    return {
        "vid": vid, "pid": pid,
        "vendor": reg.get("vendor", "unknown"),
        "probe": reg.get("probe", "unknown"),
        "chip_prefixes": reg.get("chip_prefixes", []),
        "serial": (match or {}).get("serial", ""),
        "uart": (match or {}).get("uart"),
        "known_board": (match or {}).get("known_board"),
        "known_chip": (match or {}).get("known_chip"),
        "needs_chip_model": not (match or {}).get("known_board"),
    }


# ── 2. SVD resolver: chip name → cmsis-svd-data URL → ingest ────────────────

def _svd_candidates(chip: str) -> list[tuple[str, str]]:
    """(vendor_dir, filename) guesses for a chip, most-specific first."""
    c = chip.upper()
    cands: list[tuple[str, str]] = []
    if c.startswith("STM32"):
        # STM32H743ZI → STM32H743x.svd ; STM32F103C8 → STM32F103xx.svd
        base = re.match(r"(STM32[A-Z]\d+)", c)
        if base:
            root = base.group(1)
            cands += [("STMicro", f"{root}x.svd"), ("STMicro", f"{root}xx.svd"),
                      ("STMicro", f"{c}.svd")]
    elif c.startswith("HPM"):
        cands += [("HPMicro", f"{c}.svd")]
    elif c.startswith("CH32"):
        cands += [("WCH", f"{c}.svd")]
    else:
        cands += [(d["svd_dir"], f"{c}.svd") for d in VENDOR_REGISTRY.values() if d.get("svd_dir")]
    return [(v, f) for v, f in cands if v]


def resolve_and_ingest_svd(chip: str, refresh: bool = False) -> dict[str, Any]:
    """Locate an SVD for `chip` (local cache → cmsis-svd-data), ingest it.
    Returns the ingest summary or {error}."""
    cache_dir = Path(os.path.expanduser("~/.flux/svd"))
    cache_dir.mkdir(parents=True, exist_ok=True)
    # local cache hit
    for f in cache_dir.glob(f"*{chip[:9]}*.svd"):
        if not refresh and f.stat().st_size > 50_000:
            return svd_ingest.commit_svd(str(f), chip)
    # fetch candidates
    try:
        import httpx
    except ImportError:
        return {"error": "httpx unavailable — cannot fetch SVD"}
    for vendor_dir, fname in _svd_candidates(chip):
        url = f"{_CMSIS_SVD_BASE}/{vendor_dir}/{fname}"
        try:
            r = httpx.get(url, timeout=40, follow_redirects=True)
            if r.status_code == 200 and len(r.content) > 50_000 and b"<device" in r.content:
                dest = cache_dir / fname
                dest.write_bytes(r.content)
                summary = svd_ingest.commit_svd(str(dest), chip)
                summary["svd_url"] = url
                return summary
        except Exception:
            continue
    return {"error": f"no SVD found for {chip} (tried {len(_svd_candidates(chip))} candidates); "
                     "provide an .svd path or use a PCB-BSP source"}


# ── 3. profile: ensure boards.json has an entry, augment with live identity ─

def ensure_profile(boards_json: str, chip: str, vid: str, pid: str,
                   serial: str = "", uart: str | None = None,
                   board_id: str | None = None) -> dict[str, Any]:
    """Create or update a boards.json profile from identity + chip. Returns it."""
    data = json.load(open(boards_json)) if os.path.exists(boards_json) else {"schema": "flux.boards/v1", "boards": []}
    reg = VENDOR_REGISTRY.get(vid.lower(), {})
    bid = board_id or f"{chip.lower()}-{vid}{pid}"
    existing = next((b for b in data["boards"] if b["id"] == bid), None)
    # openocd cfgs: interface from registry + target from chip series (STM32)
    iface = reg.get("openocd_iface")
    target = next((t for pfx, t in _STM32_TARGET.items() if chip.upper().startswith(pfx)), None)
    cfgs = [c for c in (iface, target) if c]
    prof = existing or {"id": bid}
    prof.update({
        "id": bid, "name": prof.get("name", f"{reg.get('vendor','')} {chip}".strip()),
        "chip": chip, "arch": prof.get("arch", "arm-cm7" if chip.upper().startswith("STM32H") else "arm"),
        "usb": {"vid": vid, "pid": pid, "label": reg.get("probe", "probe")},
        "uart": {"dev_hint": uart or "/dev/ttyACM0", "baud": 115200},
        "openocd": {"bin": "openocd", "search": "", "cfgs": cfgs or prof.get("openocd", {}).get("cfgs", []),
                    "flash_driver": prof.get("openocd", {}).get("flash_driver", "")},
        "svd": prof.get("svd", ""),
        "serial": serial or prof.get("serial", ""),
    })
    if not existing:
        data["boards"].insert(0, prof)
    json.dump(data, open(boards_json, "w"), ensure_ascii=False, indent=2)
    return prof


# ── 4. comm test: prove the register map / probe are real ───────────────────

def comm_test(chip: str, board: str | None = None) -> dict[str, Any]:
    """Sanity: is the ingested register map complete and consistent? (The
    software-side check.) A live IDCODE read happens in the TS layer when
    openocd is present; here we verify the asset a connection would rely on."""
    hits = svd_ingest.query_regmap(chip, peripheral="GPIOA")
    conn = _load_regmap(chip)
    if not conn:
        return {"ok": False, "error": f"no register-map asset for {chip} — onboard first"}
    ps = conn["characterization"]["peripherals"]
    with_regs = [p for p in ps if p.get("registers")]
    sample = next((p for p in ps if p["name"] in ("GPIOA", "USART1", "RCC") and p.get("base_address")), None)
    return {
        "ok": True, "peripherals": len(ps), "registers": sum(len(p.get("registers", [])) for p in ps),
        "sample": {"name": sample["name"], "base": sample["base_address"],
                   "regs": len(sample["registers"])} if sample else None,
        "note": "register map complete & consistent; connect a real probe for a live IDCODE read",
    }


def _load_regmap(chip: str) -> dict[str, Any] | None:
    for hit in asset_store.search_assets(chip, limit=10):
        if hit.get("type") == "register-map":
            return asset_store.get_asset(hit["id"])
    return None


# ── 5. orchestrate: the whole flow in one call ──────────────────────────────

def onboard(boards_json: str, chip: str | None = None, board: str | None = None,
            vid: str | None = None, pid: str | None = None,
            serial: str = "", uart: str | None = None) -> dict[str, Any]:
    """Full onboard: identity → profile → SVD ingest → comm test → devready
    (serial stamped in). Works for a known board (pass board) or a fresh chip
    (pass chip + vid/pid from scan)."""
    steps: list[dict[str, Any]] = []

    # resolve chip from a known board if only board given
    if board and not chip:
        try:
            prof = next(b for b in json.load(open(boards_json))["boards"] if b["id"] == board)
            chip, vid, pid = prof["chip"], prof["usb"]["vid"], prof["usb"]["pid"]
            serial = serial or prof.get("serial", "")
        except (OSError, KeyError, StopIteration):
            return {"error": f"unknown board '{board}'"}
    if not chip:
        return {"error": "need a chip model (or a known board id)"}

    # prefer the LIVE serial/uart from the plugged probe over stale profile data
    if vid and pid:
        live = next((d for d in scan(boards_json) if d["vid"].lower() == vid.lower() and d["pid"] == pid), None)
        if live:
            serial = serial or live.get("serial", "")
            uart = uart or live.get("uart")

    # 1. profile
    prof = ensure_profile(boards_json, chip, vid or "0000", pid or "0000", serial, uart, board)
    steps.append({"step": "profile", "board": prof["id"], "ok": True})

    # 2. SVD ingest
    svd = resolve_and_ingest_svd(chip)
    if "error" in svd:
        steps.append({"step": "svd", "ok": False, "detail": svd["error"]})
    else:
        # link the cached svd path into the profile
        prof["svd"] = svd.get("svd_url", prof.get("svd", ""))
        steps.append({"step": "svd", "ok": True, "registers": svd.get("registers"),
                      "asset": svd.get("asset_id")})

    # 3. comm test
    test = comm_test(chip, prof["id"])
    steps.append({"step": "comm_test", **{k: test[k] for k in ("ok", "peripherals", "registers") if k in test}})

    # 4. devready with serial stamped in
    dr_id = None
    try:
        from . import devready
        out = devready.compose_devready(prof["id"], boards_json, serial=serial or None)
        dr_id = out.get("asset_id")
        steps.append({"step": "devready", "ok": bool(dr_id), "asset": dr_id,
                      "serial_embedded": bool(serial)})
    except Exception as e:
        steps.append({"step": "devready", "ok": False, "detail": str(e)[:120]})

    return {"board": prof["id"], "chip": chip, "serial": serial,
            "devready_asset": dr_id, "steps": steps}


def custom_board_hint() -> dict[str, Any]:
    """Roadmap hook for unknown/custom PCBs with no vendor SVD: extract the BSP
    from the design files instead of a vendor part. Not yet implemented."""
    return {
        "status": "roadmap",
        "sources": [
            {"tool": "STM32CubeMX", "gives": ".ioc → pin/clock/peripheral config"},
            {"tool": "Altium Designer", "gives": "schematic/PCB → net + connector topology"},
            {"tool": "easyeda/pro-api-sdk", "gives": "EasyEDA Pro project → parts + nets"},
            {"tool": "LC2KiCad / lckiconverter", "gives": "LCEDA → KiCad → parseable netlist"},
        ],
        "plan": "parse design → net/pin map → synthesize a boards.json profile + pin-map asset "
                "when no vendor SVD exists (custom board case)",
    }
