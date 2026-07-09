"""FLUXmeme .flux asset store — real DevReady asset format integration.

Wraps the FLUXmeme C library (via Python ctypes bindings) to store and retrieve
DevReady assets as proper .flux files (Body + Mind + Journal layers).
Falls back to the SQLite asset_store.py if FLUXmeme is unavailable.
"""
from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path
from typing import Any

log = logging.getLogger("flux_brain.fluxmeme")

# FLUXmeme is at CORE27/FLUXmeme (sibling of FLUXworkbench)
_FLUXMEME_PYTHON = Path(os.environ.get(
    "FLUXMEME_PATH",
    str(Path(__file__).resolve().parents[3] / "FLUXmeme" / "python"),
))
_FLUX_DIR = Path(os.environ.get("FLUX_HOME", str(Path.home() / ".flux")))
_FLUX_DIR.mkdir(parents=True, exist_ok=True)

_lib = None
_available = False

def _try_load():
    global _lib, _available
    try:
        sys.path.insert(0, str(_FLUXMEME_PYTHON))
        from fluxmeme import Store, Record, LAYER_MIND, LAYER_BODY, LAYER_JOURNAL  # noqa: F401
        _lib = sys.modules["fluxmeme"]
        _available = True
        log.info("FLUXmeme loaded from %s", _FLUXMEME_PYTHON)
    except Exception as e:
        log.warning("FLUXmeme unavailable (%s), using SQLite fallback", e)
        _available = False


def is_available() -> bool:
    return _available


def commit_asset(asset_id: str, characterization: dict[str, Any],
                 components: list[str], session_id: str = "") -> str | None:
    """Commit an asset as a .flux file. Returns the .flux path or None."""
    if not _available:
        return None
    try:
        Store = _lib.Store  # type: ignore
        Record = _lib.Record  # type: ignore
        LAYER_MIND = _lib.LAYER_MIND  # type: ignore
        LAYER_BODY = _lib.LAYER_BODY  # type: ignore

        flux_path = str(_FLUX_DIR / f"{asset_id}.flux")
        with Store(flux_path, writable=True) as s:
            with s.write() as txn:
                # MIND layer: characterization metadata
                s.put(txn, Record(
                    layer=LAYER_MIND, kind="chip/characterize",
                    payload=json.dumps(characterization).encode(),
                    meta={"asset_id": asset_id, "session": session_id},
                ))
                # BODY layer: component manifest
                s.put(txn, Record(
                    layer=LAYER_BODY, kind="asset/components",
                    payload=json.dumps(components).encode(),
                ))
                # JOURNAL layer: provenance
                s.put(txn, Record(
                    layer=_lib.LAYER_JOURNAL, kind="asset/commit",  # type: ignore
                    payload=json.dumps({"asset_id": asset_id, "components": components}).encode(),
                ))
        log.info("FLUXmeme asset committed: %s", flux_path)
        return flux_path
    except Exception as e:
        log.warning("FLUXmeme commit failed: %s", e)
        return None


def list_assets() -> list[dict[str, Any]]:
    """List all .flux assets in the Flux directory."""
    assets = []
    if not _available:
        return assets
    try:
        Store = _lib.Store  # type: ignore
        for f in _FLUX_DIR.glob("*.flux"):
            try:
                with Store(str(f), writable=False) as s:
                    with s.read() as txn:
                        records = list(s.scan(txn))
                        mind_recs = [r for r in records if r.layer == _lib.LAYER_MIND]  # type: ignore
                        if mind_recs:
                            r = mind_recs[0]
                            assets.append({
                                "id": r.meta.get("asset_id", f.stem),
                                "path": str(f),
                                "kind": r.kind,
                                "records": len(records),
                            })
            except Exception:
                pass
    except Exception:
        pass
    return assets


# Load on import
_try_load()
