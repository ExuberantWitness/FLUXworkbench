"""CMSIS-SVD ingestion — vendor SVD file → register-map devready asset.

Deterministic, zero-model path of the ingestion flywheel (pain point ②/④):
the full register map lands in the asset store (raw), FTS indexes only the
peripheral/register names, and LLM consumers get peripheral-level slices via
slice_regmap() so multi-MB maps never enter a prompt.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from . import asset_store


def _hex(v: Any) -> str | None:
    if v is None:
        return None
    try:
        return hex(int(v))
    except (TypeError, ValueError):
        return None


def _access(v: Any) -> str | None:
    # cmsis-svd returns an SVDAccessType enum (value like "read-write") or None
    if v is None:
        return None
    return getattr(v, "value", str(v))


def parse_svd(svd_path: str) -> dict[str, Any]:
    """Parse an SVD file into the register-map characterization schema."""
    from cmsis_svd import SVDParser

    dev = SVDParser.for_xml_file(svd_path).get_device(xml_validation=False)
    peripherals = []
    for p in dev.get_peripherals():
        registers = []
        for r in p.get_registers():
            registers.append({
                "name": r.name,
                "offset": _hex(r.address_offset),
                "size": r.size,
                "access": _access(r.access),
                "reset_value": _hex(r.reset_value),
                "description": (r.description or "").strip(),
                "fields": [
                    {
                        "name": f.name,
                        "bit_offset": f.bit_offset,
                        "bit_width": f.bit_width,
                        "access": _access(f.access),
                        "description": (f.description or "").strip(),
                        "confidence": 1.0,
                    }
                    for f in r.get_fields()
                ],
            })
        peripherals.append({
            "name": p.name,
            "base_address": _hex(p.base_address),
            "group": p.group_name,
            "derived_from": p.derived_from,
            "description": (p.description or "").strip(),
            "registers": registers,
        })
    return {
        "device": {
            "name": dev.name,
            "cpu": getattr(getattr(dev, "cpu", None), "name", None),
            "width": dev.width,
            "address_unit_bits": dev.address_unit_bits,
        },
        "peripherals": peripherals,
    }


def svd_to_asset(svd_path: str, chip: str | None = None) -> dict[str, Any]:
    """Wrap a parsed SVD in the devready asset envelope."""
    char = parse_svd(svd_path)
    device = chip or char["device"]["name"]
    sha = hashlib.sha256(Path(svd_path).read_bytes()).hexdigest()
    return {
        "asset_id": f"regmap-{device.lower()}-{sha[:8]}",
        "type": "register-map",
        "source": {"kind": "svd", "path": str(svd_path), "sha256": sha},
        "components": [device, *(p["name"] for p in char["peripherals"])],
        "characterization": char,
    }


def commit_svd(svd_path: str, chip: str | None = None) -> dict[str, Any]:
    """Ingest an SVD file into the asset store. Returns a summary for tool output."""
    asset = svd_to_asset(svd_path, chip)
    asset_id = asset_store.commit_asset(asset)
    n_regs = sum(len(p["registers"]) for p in asset["characterization"]["peripherals"])
    return {
        "asset_id": asset_id,
        "type": "register-map",
        "device": asset["characterization"]["device"]["name"],
        "peripherals": len(asset["characterization"]["peripherals"]),
        "registers": n_regs,
        "components": asset["components"][:12],
    }


def slice_regmap(
    asset: dict[str, Any],
    peripheral: str | None = None,
    register: str | None = None,
) -> dict[str, Any]:
    """Cut a peripheral-level (optionally register-level) slice of a register-map
    asset — small enough (~2KB) to inject into an LLM prompt."""
    char = asset.get("characterization", {})
    device = char.get("device", {})
    out: dict[str, Any] = {"device": device, "asset_id": asset.get("asset_id", "")}
    peripherals = char.get("peripherals", [])
    if peripheral:
        want = peripheral.upper()
        matches = [p for p in peripherals if p["name"].upper() == want] or [
            p for p in peripherals if want in p["name"].upper()
        ]
    else:
        matches = peripherals[:1]
    sliced = []
    for p in matches[:2]:
        regs = p["registers"]
        if register:
            wreg = register.upper()
            regs = [r for r in regs if r["name"].upper() == wreg] or [
                r for r in regs if wreg in r["name"].upper()
            ]
        sliced.append({**p, "registers": regs[:16]})
    out["peripherals"] = sliced
    return out


def query_regmap(
    query: str, peripheral: str | None = None, register: str | None = None
) -> dict[str, Any]:
    """FTS-search register-map assets and return a prompt-sized slice."""
    hits = [a for a in asset_store.search_assets(query, limit=5) if a.get("type") == "register-map"]
    if not hits:
        return {"error": f"no register-map asset matches: {query}"}
    full = asset_store.get_asset(hits[0]["id"])
    if full is None:
        return {"error": f"asset vanished: {hits[0]['id']}"}
    return slice_regmap(full, peripheral, register)


if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("usage: python -m flux_brain.svd_ingest <file.svd> [chip]", file=sys.stderr)
        raise SystemExit(1)
    print(json.dumps(commit_svd(sys.argv[1], sys.argv[2] if len(sys.argv) > 2 else None), indent=2))
