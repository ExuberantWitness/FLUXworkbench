"""Datasheet PDF ingestion — reference-manual register chapter → register-map asset.

Second-tier ingestion source (SVD is first): text-pattern extraction from
ST-style reference manuals ("x.y.z Name register (PERIPH_REG)" / "Address
offset:" / "Reset value:" / "Bit n NAME:" blocks). Extracted registers carry
confidence < 1.0; when both a datasheet and an SVD asset exist for a device,
SVD wins by convention. Optional vision check: the page is rendered and sent
to the vision LLM to confirm the extraction (confidence bump).
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from typing import Any

from . import asset_store

_HEADER = re.compile(r"^\s*\d+\.\d+(?:\.\d+)?\s+(.+?)\s*\((\w+)_(\w+)\)\s*$", re.MULTILINE)
_OFFSET = re.compile(r"Address offset:\s*(0x[0-9A-Fa-f]+)")
_RESET = re.compile(r"Reset value:\s*(0x[0-9A-Fa-f ]+)")
_BIT = re.compile(r"^Bits?\s+(\d+)(?::(\d+))?\s+(\w+)\s*[:：]\s*(.{0,80})", re.MULTILINE)


def scan_registers(pdf_path: str, page_from: int, page_to: int) -> list[dict[str, Any]]:
    """Extract ST-style register descriptions from a page range (1-indexed, inclusive)."""
    import pdfplumber

    registers: list[dict[str, Any]] = []
    with pdfplumber.open(pdf_path) as pdf:
        text = "\n".join(
            (pdf.pages[i].extract_text() or "")
            for i in range(page_from - 1, min(page_to, len(pdf.pages)))
        )
    # split on register headers; each chunk describes one register
    heads = list(_HEADER.finditer(text))
    for idx, h in enumerate(heads):
        chunk = text[h.end(): heads[idx + 1].start() if idx + 1 < len(heads) else len(text)]
        desc, periph, reg = h.group(1), h.group(2), h.group(3)
        off = _OFFSET.search(chunk)
        rst = _RESET.search(chunk)
        fields = []
        for b in _BIT.finditer(chunk):
            hi = int(b.group(1))
            lo = int(b.group(2)) if b.group(2) else hi
            name = b.group(3)
            if name.lower() == "reserved":
                continue
            fields.append({
                "name": name,
                "bit_offset": lo,
                "bit_width": hi - lo + 1,
                "access": None,
                "description": b.group(4).strip(),
                "confidence": 0.7,
            })
        registers.append({
            "peripheral": periph,
            "name": reg,
            "offset": off.group(1) if off else None,
            "size": 32,
            "access": None,
            "reset_value": rst.group(1).replace(" ", "") if rst else None,
            "description": desc.strip(),
            "fields": fields,
        })
    return registers


def verify_with_vision(pdf_path: str, page: int, extracted: dict[str, Any]) -> float:
    """Render one page, ask the vision LLM to confirm the extraction. Returns confidence."""
    import json
    import sys
    import tempfile

    import pdfplumber

    # Reuse the running MCP server's vision channel when we're inside it
    # (avoid re-importing the module — it would double-init the LLM config).
    main_mod = sys.modules.get("__main__")
    if main_mod is not None and hasattr(main_mod, "_vision"):
        server = main_mod
    else:
        import flux_insight_mcp as server  # standalone use (spike CLI)

    with pdfplumber.open(pdf_path) as pdf:
        img = pdf.pages[page - 1].to_image(resolution=120)
        tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
        img.save(tmp.name)
    prompt = (
        "This is a reference-manual page describing MCU registers. Verify this extraction "
        f"(register name, address offset, reset value, field bit positions):\n{json.dumps(extracted)[:1200]}\n"
        'Reply ONLY JSON: {"correct": true|false, "issues": ["..."]}'
    )
    try:
        verdict = server._extract_json(server._vision(prompt, tmp.name))
        return 0.9 if verdict.get("correct") else 0.4
    except Exception:
        return 0.7  # vision unavailable — keep heuristic confidence


def commit_datasheet(
    pdf_path: str,
    page_from: int,
    page_to: int,
    chip: str,
    peripheral_hint: str | None = None,
    verify: bool = False,
) -> dict[str, Any]:
    regs = scan_registers(pdf_path, page_from, page_to)
    if peripheral_hint:
        regs = [r for r in regs if peripheral_hint.upper() in r["peripheral"].upper()]
    if not regs:
        raise ValueError(f"no registers extracted from pages {page_from}-{page_to}")

    confidence = 0.7
    if verify:
        confidence = verify_with_vision(pdf_path, page_from, regs[0])
    for r in regs:
        for f in r["fields"]:
            f["confidence"] = confidence

    # group into the register-map characterization schema (offsets are
    # peripheral-relative; base addresses live in SVD/dts assets)
    by_periph: dict[str, list[dict[str, Any]]] = {}
    for r in regs:
        by_periph.setdefault(r["peripheral"], []).append(
            {k: v for k, v in r.items() if k != "peripheral"})
    sha = hashlib.sha256(Path(pdf_path).read_bytes()).hexdigest()
    asset = {
        "asset_id": f"regmap-ds-{chip.lower()}-{(peripheral_hint or 'all').lower()}-{sha[:8]}",
        "type": "register-map",
        "source": {"kind": "datasheet-pdf", "path": str(pdf_path), "sha256": sha,
                   "pages": f"{page_from}-{page_to}", "confidence": confidence},
        "components": [chip, *by_periph.keys()],
        "characterization": {
            "device": {"name": chip},
            "peripherals": [
                {"name": p, "base_address": None, "group": p, "registers": rs}
                for p, rs in by_periph.items()
            ],
        },
    }
    asset_id = asset_store.commit_asset(asset)
    return {
        "asset_id": asset_id,
        "type": "register-map",
        "source": "datasheet-pdf",
        "chip": chip,
        "registers": len(regs),
        "fields": sum(len(r["fields"]) for r in regs),
        "confidence": confidence,
    }
