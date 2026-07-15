"""Pinmux ingestion — boards without SVDs (HPMicro's entire lineup) still get
pin-map assets: parse the vendor board file (pinmux.c) deterministically.

Verified on hpm6e00evk (334 pads, 2026-07): lines look like
    HPM_IOC->PAD[IOC_PAD_PA00].FUNC_CTL = IOC_PA00_FUNC_CTL_UART0_TXD;
grouped by the surrounding `void init_<group>_pins(...)` function.
"""
from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any

from . import asset_store

_PAD_RE = re.compile(r"IOC_PAD_(P[A-Z]+\d+)\]\.FUNC_CTL\s*=\s*IOC_P\w+_FUNC_CTL_(\w+)")
_GROUP_RE = re.compile(r"void\s+init_(\w+)_pins")


def parse_pinmux(pinmux_path: str) -> list[dict[str, str]]:
    src = Path(os.path.expanduser(pinmux_path)).read_text(errors="replace")
    pins: list[dict[str, str]] = []
    group = "misc"
    for line in src.splitlines():
        g = _GROUP_RE.search(line)
        if g:
            group = g.group(1)
        m = _PAD_RE.search(line)
        if m:
            pins.append({"pad": m.group(1), "function": m.group(2), "group": group})
    return pins


def commit_pinmux(pinmux_path: str, board: str) -> dict[str, Any]:
    pins = parse_pinmux(pinmux_path)
    if not pins:
        return {"error": f"no pinmux entries found in {pinmux_path}"}
    groups = sorted({p["group"] for p in pins})
    asset_id = asset_store.commit_asset({
        "asset_id": f"pinmap-{board}",
        "type": "characterization",
        "source": {"kind": "pinmux-parse", "path": pinmux_path},
        "components": [board, *groups[:16]],
        "characterization": {"board": board, "pin_count": len(pins), "pins": pins},
    })
    return {"asset_id": asset_id, "type": "characterization",
            "pin_count": len(pins), "groups": groups}


# ── board profiles + studio skills (repo-native knowledge) ──────────────────

def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def load_boards() -> list[dict[str, Any]]:
    try:
        data = json.loads((_repo_root() / "skills" / "boards.json").read_text())
        return data.get("boards", [])
    except (OSError, json.JSONDecodeError):
        return []


def board_profile(board: str) -> dict[str, Any] | None:
    return next((b for b in load_boards() if b.get("id") == board), None)


def list_skills() -> list[dict[str, str]]:
    out = []
    d = _repo_root() / "skills"
    if d.exists():
        for p in sorted(d.glob("*.md")):
            first = p.read_text(errors="replace").lstrip().splitlines()[:1]
            out.append({"name": p.stem, "title": (first[0] if first else "").lstrip("# ").strip()})
    return out


def get_skill(name: str) -> str | None:
    p = _repo_root() / "skills" / f"{Path(name).stem}.md"
    return p.read_text(errors="replace") if p.exists() else None
