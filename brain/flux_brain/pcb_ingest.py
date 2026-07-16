"""PCB / hardware-design ingestion — turn a board's design files into a board
profile + pin-map + schematic-knowledge asset, so firmware can be developed for
a CUSTOM board that has no vendor SVD/pinmux.c.

This is the implementation of onboard.custom_board_hint(): a real board (e.g.
the Vigilator) ships design files, not a vendor part number. We extract the BSP
from those files instead.

Formats, by how directly they yield a BSP (parse the richest one present):
  1. STM32CubeMX  .ioc   — pin mux + peripherals, plain text. Authoritative for
                            STM32 firmware (it IS what the pins are wired to).
  2. Altium/Protel .NET  — parts list + net connectivity, plain text. Gives the
                            BOM + which sensor sits on which net.
  3. KiCad  .kicad_pcb / .net   — roadmap (S-expr / netlist)
  4. EasyEDA JSON               — roadmap (easyeda pro-api-sdk)
The Altium BINARY files (.PcbDoc/.SchDoc, OLE2) are proprietary and NOT needed —
the .NET netlist carries the connectivity we want.
"""
from __future__ import annotations

import os
import re
import time
from pathlib import Path
from typing import Any

from . import asset_store

# STM32 series → arch + openocd target (for the generated profile).
_STM32_ARCH = {
    "STM32L0": ("cortex-m0plus", "target/stm32l0.cfg"),
    "STM32L4": ("cortex-m4", "target/stm32l4x.cfg"),
    "STM32F0": ("cortex-m0", "target/stm32f0x.cfg"),
    "STM32F1": ("cortex-m3", "target/stm32f1x.cfg"),
    "STM32F4": ("cortex-m4", "target/stm32f4x.cfg"),
    "STM32H7": ("cortex-m7", "target/stm32h7x.cfg"),
    "STM32G0": ("cortex-m0plus", "target/stm32g0x.cfg"),
    "STM32G4": ("cortex-m4", "target/stm32g4x.cfg"),
}


# ── 1. STM32CubeMX .ioc — pin mux + peripherals ─────────────────────────────

def parse_ioc(ioc_path: str) -> dict[str, Any]:
    """Parse a CubeMX .ioc into {mcu, family, device, peripherals, pins}."""
    text = Path(os.path.expanduser(ioc_path)).read_text(errors="ignore")
    kv: dict[str, str] = {}
    for line in text.splitlines():
        if "=" in line and not line.startswith("#"):
            k, v = line.split("=", 1)
            kv[k.strip()] = v.strip()

    device = kv.get("ProjectManager.DeviceId") or kv.get("Mcu.UserName") or kv.get("Mcu.Name", "")
    family = kv.get("Mcu.Family", "")

    # peripherals: Mcu.IPn=ADC / USART2 / TIM2 …
    peripherals = sorted({v for k, v in kv.items()
                          if re.match(r"Mcu\.IP\d+$", k) and v not in ("NVIC", "GPIO", "SYS", "RCC")})

    # pins: <Pin>.Signal + <Pin>.GPIO_Label + <Pin>.Mode
    pin_names: set[str] = set()
    for k in kv:
        m = re.match(r"(P[A-H]\d+(?:-[A-Z0-9_]+)?)\.", k)
        if m:
            pin_names.add(m.group(1))
    pins = []
    for p in sorted(pin_names, key=_pin_sort_key):
        base = p.split("-")[0]  # PA0-CK_IN → PA0
        signal = kv.get(f"{p}.Signal", "")
        label = kv.get(f"{p}.GPIO_Label", "")
        mode = kv.get(f"{p}.Mode", "")
        if not (signal or label):
            continue
        pins.append({"pin": base, "signal": signal, "label": label,
                     "mode": mode, "function": _classify_pin(signal, label)})
    return {"mcu": device, "family": family, "device": device,
            "peripherals": peripherals, "pins": pins}


def _pin_sort_key(p: str) -> tuple[str, int]:
    m = re.match(r"P([A-H])(\d+)", p)
    return (m.group(1), int(m.group(2))) if m else (p, 0)


def _classify_pin(signal: str, label: str) -> str:
    s = (signal + " " + label).upper()
    if "SWDIO" in s or "SWCLK" in s or "SYS_" in s and "WK" not in s:
        return "debug"
    if "USART" in s or "UART" in s:
        return "uart"
    if "I2C" in s:
        return "i2c"
    if "SPI" in s:
        return "spi"
    if "ADC" in s:
        return "adc"
    if "TIM" in s or "PWM" in s or "BUZZER" in s:
        return "timer/pwm"
    if "WKUP" in s or "WK" in s:
        return "wakeup"
    if "LED" in s:
        return "gpio/led"
    if "GPIO" in s:
        return "gpio"
    return "other"


# ── 2. Altium / Protel .NET — BOM + net connectivity ────────────────────────

# component designator at end-of-token (Protel fixed-width columns overflow and
# glue footprint+ref, e.g. "SOP65P640X120-20NU3" → footprint "…20N" + ref "U3").
# Known two-letter prefixes first, then a SINGLE-letter fallback so a footprint's
# trailing letter (…20N) stays with the footprint, not the ref.
_DESIG = re.compile(r"(SW|TP|BT|JP|[A-Z])(\d+)$")


def parse_altium_net(net_path: str) -> dict[str, Any]:
    """Parse a Protel/Altium .NET: PARTS LIST + NODENAME net sections. Robust to
    fixed-width column overflow (glued footprint+ref) and header-less net lists."""
    text = Path(os.path.expanduser(net_path)).read_text(errors="ignore")
    parts: list[dict[str, str]] = []
    nets: list[dict[str, Any]] = []
    section = "parts"  # a .NET opens with the parts list
    cur_net: dict[str, Any] | None = None
    for raw in text.splitlines():
        line = raw.rstrip()
        st = line.strip()
        if st in ("PARTS LIST", "PART LIST"):
            section = "parts"; continue
        if st in ("NET LIST", "NETS"):
            section = "nets"; continue
        if st == "EOS":
            section = None; continue  # ends the current section, not the file
        # also switch on the first NODENAME (some netlists are header-less).
        if st.startswith("NODENAME"):
            section = "nets"
        if section == "parts" and st:
            # columns are separated by 2+ spaces; value may contain spaces.
            cols = re.split(r"\s{2,}", st)
            if len(cols) >= 3:
                val, foot, ref = cols[0], cols[1], cols[-1]
            elif len(cols) == 2:
                # footprint+ref glued in the 2nd column (overflowed footprint).
                val = cols[0]
                m = _DESIG.search(cols[1])
                if m:
                    ref = m.group(0)
                    foot = cols[1][: m.start()]
                else:
                    foot, ref = cols[1], "?"
            else:
                continue
            if _DESIG.search(ref):
                parts.append({"ref": ref, "footprint": foot, "value": val})
        elif section == "nets":
            nm = re.match(r"NODENAME\s+(\S+)", st)
            if nm:
                if cur_net:
                    nets.append(cur_net)
                cur_net = {"name": nm.group(1), "nodes": []}
            elif cur_net is not None and st and st != "$":
                toks = st.replace("$", "").split()
                for i in range(0, len(toks) - 1, 2):
                    if _DESIG.search(toks[i]):
                        cur_net["nodes"].append({"ref": toks[i], "pin": toks[i + 1]})
    if cur_net:
        nets.append(cur_net)
    return {"parts": parts, "nets": nets}


def _mcu_ref(parts: list[dict[str, str]]) -> dict[str, str] | None:
    """Find the MCU in the BOM (value looks like an STM32/GD32/etc part number)."""
    for p in parts:
        if re.match(r"(STM32|GD32|APM32|AT32|CH32|NRF|ESP32|RP2040)", p["value"], re.I):
            return p
    return None


def _net_of(nets: list[dict[str, Any]], ref: str, pin: str) -> str | None:
    for n in nets:
        for node in n["nodes"]:
            if node["ref"] == ref and node["pin"] == pin:
                return n["name"]
    return None


# ── 2b. FUSE: MCU physical pin (.NET) ↔ net ↔ logical function (.ioc) ↔ devices
# This is the "what is the MCU actually wired to" table firmware needs. Device
# connectivity comes purely from the netlist (100% reliable); the logical
# function (.ioc PA-name / uart/i2c/…) is attached when the net name matches an
# .ioc pin label (exact → normalized → digit-stripped → common-prefix).

def _norm(s: str) -> str:
    return re.sub(r"[^A-Z0-9]", "", s.upper())


def _match_ioc(netname: str, ioc_by_label: dict[str, dict[str, Any]]) -> dict[str, Any] | None:
    """Bridge a net name to an .ioc pin label, tolerating naming drift."""
    if netname in ioc_by_label:
        return ioc_by_label[netname]
    nn = _norm(netname)
    norms = {_norm(k): v for k, v in ioc_by_label.items()}
    if nn in norms:
        return norms[nn]
    nd = re.sub(r"\d", "", nn)  # USART2TX ↔ USARTTX
    for k, v in norms.items():
        if re.sub(r"\d", "", k) == nd and nd:
            return v
    for k, v in norms.items():  # KEYWK ⊂ KEYWKUP, or share ≥4-char prefix
        if len(nn) >= 3 and len(k) >= 3 and (nn.startswith(k) or k.startswith(nn)
                                             or (len(os.path.commonprefix([nn, k])) >= 4)):
            return v
    return None


# passive/power refs that aren't "devices the firmware talks to"
_PASSIVE = re.compile(r"^(C|R|L|Y|FB|D)\d")
_POWER_NET = re.compile(r"^(GND|VCC|VDD|VBAT|VBUS|VSS|\+\d|-\d|VCC_|HS_VIO|NRST|VDDA)", re.I)


def fuse_connections(ioc_pins: list[dict[str, Any]], net_data: dict[str, Any],
                     mcu_ref: str) -> list[dict[str, Any]]:
    """Per MCU pin: {mcu_pin, net, gpio, signal, function, devices[]}."""
    ioc_by_label = {p["label"]: p for p in ioc_pins if p.get("label")}
    part_name = {p["ref"]: p["value"] for p in net_data["parts"]}
    rows: list[dict[str, Any]] = []
    for n in net_data["nets"]:
        mcu_pins = [nd["pin"] for nd in n["nodes"] if nd["ref"] == mcu_ref]
        if not mcu_pins:
            continue
        devices = [{"ref": nd["ref"], "part": part_name.get(nd["ref"], "?"), "pin": nd["pin"]}
                   for nd in n["nodes"]
                   if nd["ref"] != mcu_ref and not _PASSIVE.match(nd["ref"])]
        iocp = _match_ioc(n["name"], ioc_by_label)
        for mp in mcu_pins:
            row: dict[str, Any] = {"mcu_pin": mp, "net": n["name"],
                                   "is_power": bool(_POWER_NET.match(n["name"])),
                                   "devices": devices}
            if iocp:
                row.update({"gpio": iocp["pin"], "signal": iocp["signal"],
                            "function": iocp["function"], "label": iocp["label"]})
            rows.append(row)
    rows.sort(key=lambda r: int(r["mcu_pin"]) if r["mcu_pin"].isdigit() else 999)
    return rows


# ── 3. orchestrate: design dir → board profile + pin-map + design asset ──────

def ingest_design(project_dir: str, boards_json: str | None = None,
                  board_id: str | None = None) -> dict[str, Any]:
    """Detect design files in a project dir, extract the BSP, commit a pin-map /
    design asset, and (if boards_json) synthesize a board profile."""
    d = Path(os.path.expanduser(project_dir))
    if not d.exists():
        return {"error": f"project dir not found: {project_dir}"}
    iocs = list(d.rglob("*.ioc"))
    nets = list(d.rglob("*.NET")) + list(d.rglob("*.net"))
    kicad = list(d.rglob("*.kicad_pcb"))
    if not iocs and not nets and not kicad:
        return {"error": "no recognized design files (.ioc / .NET / .kicad_pcb) found",
                "hint": "KiCad .kicad_pcb and EasyEDA JSON parsing are on the roadmap"}

    ioc = parse_ioc(str(iocs[0])) if iocs else {}
    net = parse_altium_net(str(nets[0])) if nets else {"parts": [], "nets": []}
    if kicad and not iocs:
        return {"error": "KiCad-only projects not yet supported (roadmap)",
                "found": [p.name for p in kicad]}

    # MCU: prefer the .ioc device, fall back to the BOM.
    mcu_bom = _mcu_ref(net["parts"]) if net["parts"] else None
    chip = ioc.get("device") or (mcu_bom["value"] if mcu_bom else "")
    if not chip:
        return {"error": "could not identify the MCU from .ioc or BOM"}
    fam = next((f for f in _STM32_ARCH if chip.upper().startswith(f)), None)
    arch, target = _STM32_ARCH.get(fam or "", ("arm", ""))

    bid = board_id or re.sub(r"[^a-z0-9]+", "-", (ioc.get("mcu") or d.name).lower()).strip("-")

    # pins: from the .ioc, cross-referenced with the net name at the MCU pin
    # (physical wire) when the netlist is present.
    mcu_ref = mcu_bom["ref"] if mcu_bom else "U?"
    pins = []
    for pin in ioc.get("pins", []):
        entry = dict(pin)
        pins.append(entry)

    # notable non-MCU parts (sensors, regulators, connectors) = the board's real
    # peripherals — what firmware ultimately talks to.
    devices = [p for p in net["parts"]
               if re.match(r"[UDP]\d", p["ref"]) and p["ref"] != mcu_ref
               and not re.match(r"0603|0402|Cap|Res", p["footprint"], re.I)]

    # THE fusion table: MCU physical pin ↔ net ↔ logical function ↔ devices.
    connections = fuse_connections(ioc.get("pins", []), net, mcu_ref) if net["nets"] else []
    # firmware-facing summary: which GPIO drives which device, by function.
    device_map = []
    for row in connections:
        if row["devices"] and not row["is_power"]:
            device_map.append({
                "gpio": row.get("gpio", f"{mcu_ref}.{row['mcu_pin']}"),
                "function": row.get("function", "gpio"),
                "signal": row.get("signal", ""),
                "net": row["net"],
                "connects_to": [f"{d['part']}({d['ref']}.{d['pin']})" for d in row["devices"]],
            })

    characterization = {
        "source": "pcb-design",
        "mcu": chip, "family": ioc.get("family", fam or ""),
        "arch": arch, "peripherals": ioc.get("peripherals", []),
        "pins": pins, "pin_count": len(pins),
        "bom_parts": len(net["parts"]),
        "board_devices": [{"ref": p["ref"], "part": p["value"], "footprint": p["footprint"]}
                          for p in devices],
        "nets": len(net["nets"]),
        "connections": connections,   # full per-MCU-pin table
        "device_map": device_map,     # firmware-facing: GPIO → device
        "key_nets": [n["name"] for n in net["nets"]
                     if not re.match(r"(GND|VCC|VDD|VBAT|NetC|NetR|NetD|NetQ)", n["name"], re.I)][:24],
    }
    asset_id = asset_store.commit_asset({
        "asset_id": f"pcbmap-{bid}",
        "type": "characterization",
        "source": {"kind": "pcb-design", "project": str(d),
                   "files": [p.name for p in iocs + nets]},
        "components": [chip, *ioc.get("peripherals", []),
                       *[p["value"] for p in devices][:8]],
        "characterization": characterization,
    })

    out: dict[str, Any] = {
        "asset_id": asset_id, "board": bid, "mcu": chip, "arch": arch,
        "pin_count": len(pins), "peripherals": ioc.get("peripherals", []),
        "board_devices": [f"{p['ref']}={p['value']}" for p in devices],
        "sources": {"ioc": bool(iocs), "netlist": bool(nets)},
    }

    # synthesize a board profile so onboard/build/mission can use it
    if boards_json:
        out["profile"] = _write_profile(boards_json, bid, chip, arch, target,
                                         ioc.get("pins", []))
    return out


def _write_profile(boards_json: str, bid: str, chip: str, arch: str,
                   target: str, pins: list[dict[str, Any]]) -> dict[str, Any]:
    import json
    data = json.load(open(boards_json)) if os.path.exists(boards_json) else {"schema": "flux.boards/v1", "boards": []}
    uart = next((p for p in pins if p["function"] == "uart" and "RX" in (p["label"] + p["signal"]).upper()), None)
    prof = next((b for b in data["boards"] if b["id"] == bid), None) or {"id": bid}
    prof.update({
        "id": bid, "name": prof.get("name", f"{chip} (PCB design)"),
        "chip": chip, "arch": arch,
        "usb": prof.get("usb", {"vid": "0483", "pid": "374b", "label": "ST-Link (assumed)"}),
        "uart": {"dev_hint": "/dev/ttyUSB0", "baud": 115200},
        "openocd": {"bin": "openocd", "search": "",
                    "cfgs": ["interface/stlink.cfg", target] if target else ["interface/stlink.cfg"],
                    "flash_driver": f"{(next((f for f in _STM32_ARCH), '')).lower()} (upstream)"},
        "pcb_pinmap": f"pcbmap-{bid}",
        "source": "pcb-design",
    })
    if bid not in [b["id"] for b in data["boards"]]:
        data["boards"].insert(0, prof)
    json.dump(data, open(boards_json, "w"), ensure_ascii=False, indent=2)
    return {"id": bid, "chip": chip, "arch": arch, "written": True}
