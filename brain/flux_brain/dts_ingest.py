"""Zephyr devicetree ingestion — flattened build/zephyr/zephyr.dts → devready asset.

Parses the BUILD ARTIFACT (already flattened, overlays applied) with Zephyr's
own dtlib, sidestepping the include/overlay maze. Node reg addresses join
against register-map assets (dts says WHERE uart0 is, the SVD asset says WHAT
its registers mean) — the cross-asset query the chat/triage context uses.
"""
from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path
from typing import Any

from . import asset_store

ZEPHYR_BASE = os.environ.get(
    "ZEPHYR_BASE",
    str(Path(__file__).resolve().parents[2] / "vendor" / "zephyrproject" / "zephyr"),
)


def _dtlib():
    """Zephyr vendors python-devicetree inside its tree — import from there."""
    dts_pkg = Path(ZEPHYR_BASE) / "scripts" / "dts" / "python-devicetree" / "src"
    if str(dts_pkg) not in sys.path:
        sys.path.insert(0, str(dts_pkg))
    from devicetree import dtlib  # type: ignore
    return dtlib


def parse_dts(dts_path: str) -> dict[str, Any]:
    """Flattened .dts → {chosen, nodes[{path,labels,compatible,reg,status}]}."""
    dtlib = _dtlib()
    dt = dtlib.DT(dts_path)
    nodes = []
    for node in dt.node_iter():
        props = node.props
        compat = props["compatible"].to_strings() if "compatible" in props else []
        if not compat:
            continue
        entry: dict[str, Any] = {
            "path": node.path,
            "labels": sorted(node.labels),
            "compatible": compat,
            "status": props["status"].to_string() if "status" in props else "okay",
        }
        if "reg" in props:
            try:
                nums = props["reg"].to_nums()
                # #address-cells/#size-cells vary; the flattened soc bus is 1/1
                entry["reg"] = [
                    {"addr": hex(nums[i]), "size": hex(nums[i + 1]) if i + 1 < len(nums) else "0x0"}
                    for i in range(0, len(nums), 2)
                ]
            except Exception:
                pass
        nodes.append(entry)
    chosen = {}
    if dt.has_node("/chosen"):
        for name, prop in dt.get_node("/chosen").props.items():
            try:
                chosen[name] = prop.to_path().path
            except Exception:
                try:
                    chosen[name] = prop.to_string()
                except Exception:
                    continue
    return {"chosen": chosen, "nodes": nodes}


def commit_dts(dts_path: str, board: str) -> dict[str, Any]:
    char = parse_dts(dts_path)
    char["board"] = board
    sha = hashlib.sha256(Path(dts_path).read_bytes()).hexdigest()
    labels = sorted({lb for n in char["nodes"] for lb in n["labels"]})[:48]
    asset_id = asset_store.commit_asset({
        "asset_id": f"hwdesc-{board.replace('/', '-')}-{sha[:8]}",
        "type": "devicetree",
        "source": {"kind": "zephyr-dts", "path": str(dts_path), "sha256": sha, "board": board},
        "components": [board, *labels],
        "characterization": char,
    })
    return {
        "asset_id": asset_id,
        "type": "devicetree",
        "board": board,
        "nodes": len(char["nodes"]),
        "chosen": char["chosen"],
    }


def join_regmap(dts_asset_id: str, chip_query: str, label: str) -> dict[str, Any]:
    """Cross-asset join: dts node (by label) reg.addr ↔ register-map base_address."""
    from . import svd_ingest

    dts = asset_store.get_asset(dts_asset_id)
    if dts is None:
        return {"error": f"no devicetree asset: {dts_asset_id}"}
    node = next(
        (n for n in dts["characterization"]["nodes"] if label in n.get("labels", [])), None)
    if node is None or not node.get("reg"):
        return {"error": f"node label not found or no reg: {label}"}
    addr = node["reg"][0]["addr"]

    hits = [a for a in asset_store.search_assets(chip_query, limit=5) if a.get("type") == "register-map"]
    if not hits:
        return {"node": node, "regmap": None}
    full = asset_store.get_asset(hits[0]["id"])
    periph = next(
        (p for p in full["characterization"]["peripherals"]
         if p.get("base_address") and int(p["base_address"], 16) == int(addr, 16)), None)
    return {
        "node": node,
        "regmap": svd_ingest.slice_regmap(full, peripheral=periph["name"]) if periph else None,
        "joined_on": addr,
    }
