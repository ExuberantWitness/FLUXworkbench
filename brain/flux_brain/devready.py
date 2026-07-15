"""DevReady composer — assemble a self-describing BODY/MIND/JOURNAL asset.

Implements the FLUXmeme DevReady philosophy for dev boards: one asset that
any person or agent can pick up and start working from — structure (BODY),
development context and skills (MIND), and lifetime records (JOURNAL).

Everything gathered here is DETERMINISTIC: parsed from the SDK tree, the
board profile, and existing store assets. Nothing is invented by a model.
"""
from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any

from . import asset_store

# Known RTOS / kernel middleware directory names → display names.
_RTOS_DIRS = {
    "FreeRTOS": "FreeRTOS",
    "freertos": "FreeRTOS",
    "rtthread": "RT-Thread",
    "rtthread-nano": "RT-Thread Nano",
    "eclipse_threadx": "Eclipse ThreadX (Azure RTOS)",
    "ucos_iii": "uC/OS-III",
    "zephyr": "Zephyr",
}


def _x(p: str | None) -> Path | None:
    return Path(os.path.expanduser(p)) if p else None


def detect_rtos(sdk_path: str | None) -> dict[str, Any]:
    """Scan the SDK for RTOS support: which kernels ship, which samples exist.
    Honest status: presence in the SDK ≠ configured on this board."""
    out: dict[str, Any] = {"default_runtime": "bare-metal", "available": [], "configured": None,
                           "note": "no RTOS is configured by default; kernels below ship with the SDK"}
    sdk = _x(sdk_path)
    if not sdk or not sdk.exists():
        out["note"] = "SDK not found — RTOS availability unknown"
        return out
    mw = sdk / "middleware"
    if mw.exists():
        for d in sorted(mw.iterdir()):
            if d.is_dir() and d.name in _RTOS_DIRS:
                entry: dict[str, Any] = {"name": _RTOS_DIRS[d.name], "middleware_dir": f"middleware/{d.name}"}
                out["available"].append(entry)
    rtos_samples = sdk / "samples" / "rtos"
    if rtos_samples.exists():
        sample_map: dict[str, int] = {}
        for d in sorted(rtos_samples.iterdir()):
            if d.is_dir():
                sample_map[d.name] = sum(1 for _ in d.rglob("CMakeLists.txt"))
        out["rtos_samples"] = sample_map
    return out


def parse_memory_map(ld_path: str | None) -> list[dict[str, str]]:
    """MEMORY { NAME (attrs) : ORIGIN = ..., LENGTH = ... } from a linker script."""
    ld = _x(ld_path)
    if not ld or not ld.exists():
        return []
    text = ld.read_text(errors="ignore")
    m = re.search(r"MEMORY\s*\{(.*?)\}", text, re.DOTALL)
    if not m:
        return []
    regions = []
    for line in m.group(1).splitlines():
        rm = re.match(r"\s*(\w+)\s*\(([^)]*)\)\s*:\s*ORIGIN\s*=\s*([^,]+),\s*LENGTH\s*=\s*(.+?)\s*$", line)
        if rm:
            regions.append({"region": rm.group(1), "attrs": rm.group(2).strip(),
                            "origin": rm.group(3).strip(), "length": rm.group(4).strip()})
    return regions


def _boot_modes(ld_dir: Path | None) -> list[str]:
    if not ld_dir or not ld_dir.exists():
        return []
    return sorted(p.stem for p in ld_dir.glob("*.ld"))


def _load_profile(board: str, boards_json: str) -> dict[str, Any] | None:
    try:
        data = json.loads(Path(boards_json).read_text())
        for b in data.get("boards", []):
            if b.get("id") == board:
                return b
    except (OSError, json.JSONDecodeError):
        pass
    return None


def compose_devready(board: str, boards_json: str) -> dict[str, Any]:
    """Aggregate profile + SDK scans + store assets into one devready asset."""
    profile = _load_profile(board, boards_json)
    if not profile:
        return {"error": f"board '{board}' not in {boards_json}"}
    build = profile.get("build", {})
    ocd = profile.get("openocd", {})
    sdk_path = build.get("sdk_path")

    # linker dir: <sdk>/soc/<SERIES>/<CHIP>/toolchains/gcc — locate by chip name
    ld_dir: Path | None = None
    ld_file: str | None = None
    sdk = _x(sdk_path)
    chip = str(profile.get("chip", ""))
    if sdk and sdk.exists():
        hits = list(sdk.glob(f"soc/*/{chip}/toolchains/gcc")) or list(sdk.glob(f"soc/{chip}*/toolchains/gcc"))
        if hits:
            ld_dir = hits[0]
            cand = ld_dir / "flash_xip.ld"
            ld_file = str(cand) if cand.exists() else None

    # ── BODY: structure & topology ──
    pinmap = asset_store.get_asset(f"pinmap-{board}")
    pins = (pinmap or {}).get("characterization", {}).get("pins", [])
    body = {
        "chip": chip,
        "series": profile.get("name", ""),
        "arch": profile.get("arch", ""),
        "memory_map": parse_memory_map(ld_file),
        "boot_modes": _boot_modes(ld_dir),
        "pinmap": {"asset_ref": f"pinmap-{board}" if pinmap else None,
                   "pin_count": len(pins), "pins": pins},
        "debug_topology": {
            "probe": profile.get("usb", {}),
            "transport": "JTAG",
            "tap_id": ocd.get("tap_id"),
            "flash_driver": ocd.get("flash_driver"),
        },
        "console": profile.get("uart", {}),
        # USD shell slot: the board's physical form (outline, mounting, 3D
        # model ref) — feeds bracket/enclosure design and robot integration.
        # Populated from the profile now; a vendor STEP / FluxWeave URDF or
        # USD ref lands here when attached.
        "geometry": profile.get("geometry", {
            "usd_ref": None, "model_ref": None, "dimensions_mm": None,
            "mounting": None, "note": "no geometry captured yet"}),
    }

    # ── MIND: development context, RTOS state, skills, memory ──
    exp = asset_store.get_asset(f"experience-{board}-bringup")
    samples = 0
    if sdk and (sdk / "samples").exists():
        samples = sum(1 for _ in (sdk / "samples").rglob("CMakeLists.txt"))

    # Debugging memory: curated lessons from the experience asset + lessons
    # auto-distilled from this board's triage cases and fault knowledge. This
    # is how the asset REMEMBERS what hurt — the next agent doesn't re-learn.
    memory: list[dict[str, Any]] = []
    for lesson in (exp or {}).get("characterization", {}).get("lessons", []):
        memory.append({**lesson, "origin": "curated"})
    for hit in asset_store.search_assets(board, limit=50):
        if hit.get("type") == "triage-case":
            case = asset_store.get_asset(hit["id"]) or {}
            cc = case.get("characterization", {})
            fixes = cc.get("suggested_fixes", [])
            memory.append({
                "symptom": str(cc.get("root_cause", ""))[:200],
                "category": cc.get("category", ""),
                "fix": fixes[0].get("title", "") if fixes else "",
                "origin": "triage", "ref": hit["id"],
            })
        elif hit.get("type") == "fault-knowledge":
            fk = asset_store.get_asset(hit["id"]) or {}
            memory.append({
                "symptom": str(fk.get("characterization", {}).get("summary", ""))[:200],
                "origin": "dream-consolidated", "ref": hit["id"],
            })
    mind = {
        "rtos": detect_rtos(sdk_path),
        "toolchain": {"env": build.get("toolchain_env"), "path_glob": build.get("toolchain_glob"),
                      "provision": profile.get("provision_hint", "")},
        "sdk": {"env": build.get("sdk_env"), "path": sdk_path, "sample_count": samples},
        "build_howto": {
            "board_arg": build.get("board_arg"),
            "command": f"cmake -GNinja -DBOARD={build.get('board_arg')} -DCMAKE_BUILD_TYPE=flash_xip .. && ninja",
            "sample_entry": build.get("sample"),
        },
        "flash_debug_howto": {
            "openocd_bin": ocd.get("bin"), "openocd_search": ocd.get("search"),
            "cfgs": ocd.get("cfgs", []),
            "studio": "Real tab → scan → authorize → connect → HIL flash step",
        },
        "experience": (exp or {}).get("characterization", {}),
        "memory": memory,
        # Authoritative external docs travel WITH the asset — the agent never
        # has to guess where the board's official README lives.
        "references": profile.get("references", []),
        "agent_skills": [
            {"tool": "gen_test_plan", "for": "asset-driven HIL test plans"},
            {"tool": "ingest_pinmux", "for": "refresh pin map from SDK"},
            {"tool": "flux:build", "for": "cross-compile via studio kernel"},
            {"tool": "flux:hilRun", "for": "flash + verify on mock/sim/real"},
            {"tool": "export_asset / import_asset", "for": "carry this DevReady pack to another machine"},
        ],
    }

    # ── JOURNAL: lifetime records already in the store ──
    linked: dict[str, list[str]] = {"missions": [], "hil_reports": [], "triage_cases": [], "evidence": []}
    for hit in asset_store.search_assets(board, limit=50):
        t = hit.get("type", "")
        if t == "mission":
            linked["missions"].append(hit["id"])
        elif t == "hil-report":
            linked["hil_reports"].append(hit["id"])
        elif t == "triage-case":
            linked["triage_cases"].append(hit["id"])
        elif t == "evidence-bundle":
            linked["evidence"].append(hit["id"])
    journal = {
        "linked_records": linked,
        "health": {"last_verified": time.strftime("%Y-%m-%d %H:%M"),
                   "verification": "characterized (pin map); firmware HIL pending real-probe run",
                   "drift_notes": []},
    }

    asset_id = asset_store.commit_asset({
        "asset_id": f"devready-{board}",
        "type": "devready",
        "source": {"kind": "devready-compose", "board": board,
                   "spec": "FLUXmeme DevReady (BODY/MIND/JOURNAL)"},
        "components": [board, chip, *[r["name"] for r in mind["rtos"].get("available", [])]],
        "characterization": {"body": body, "mind": mind, "journal": journal},
        "health": journal["health"],
    })
    return {"asset_id": asset_id, "type": "devready",
            "body_pins": len(pins), "memory_regions": len(body["memory_map"]),
            "boot_modes": len(body["boot_modes"]),
            "geometry": bool(body["geometry"].get("usd_ref") or body["geometry"].get("dimensions_mm")),
            "rtos_available": [r["name"] for r in mind["rtos"].get("available", [])],
            "memory_lessons": len(memory), "references": len(mind["references"]),
            "journal_links": {k: len(v) for k, v in linked.items()}}
