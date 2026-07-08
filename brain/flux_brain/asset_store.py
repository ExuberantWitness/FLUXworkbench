"""Minimal devready asset store — SQLite FTS5 search over committed assets.

The flywheel: each vertical run commits an asset bundle → stored here →
asset.search() retrieves relevant past assets as context for the next run.
This completes pain point ④ (context/asset management防失控) and the flywheel
verification step (plan §验证 step 8).
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path
from typing import Any

FLUX_DIR = Path(os.environ.get("FLUX_HOME", str(Path.home() / ".flux")))
DB_PATH = FLUX_DIR / "assets.db"


def _ensure_db() -> sqlite3.Connection:
    FLUX_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(DB_PATH))
    conn.execute("""
        CREATE TABLE IF NOT EXISTS assets (
            id TEXT PRIMARY KEY,
            ts REAL,
            components TEXT,
            characterization TEXT,
            session_id TEXT,
            lineage TEXT,
            raw TEXT
        )
    """)
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS assets_fts USING fts5(
            id, components, characterization, tags
        )
    """)
    conn.commit()
    return conn


def commit_asset(event_data: dict[str, Any]) -> str:
    """Store an asset.committed event's data. Returns the asset_id."""
    conn = _ensure_db()
    asset_id = event_data.get("asset_id", f"asset-{int(time.time())}")
    components = json.dumps(event_data.get("components", []), ensure_ascii=False)
    char = json.dumps(event_data.get("characterization", {}), ensure_ascii=False)
    session = event_data.get("session", {})
    session_id = session.get("id", "")
    lineage = json.dumps(session.get("lineage", {}), ensure_ascii=False)
    raw = json.dumps(event_data, ensure_ascii=False)

    conn.execute(
        "INSERT OR REPLACE INTO assets VALUES (?,?,?,?,?,?,?)",
        (asset_id, time.time(), components, char, session_id, lineage, raw),
    )
    # FTS index
    conn.execute(
        "INSERT OR REPLACE INTO assets_fts VALUES (?,?,?,?)",
        (asset_id, components, char, " ".join(event_data.get("components", []))),
    )
    conn.commit()
    conn.close()
    return asset_id


def search_assets(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Full-text search over committed assets. Returns matching asset dicts."""
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT a.id, a.ts, a.components, a.characterization, a.session_id "
        "FROM assets_fts f JOIN assets a ON f.id = a.id "
        "WHERE assets_fts MATCH ? ORDER BY rank LIMIT ?",
        (query, limit),
    ).fetchall()
    conn.close()
    return [
        {
            "id": r[0],
            "ts": r[1],
            "components": json.loads(r[2]) if r[2] else [],
            "characterization": json.loads(r[3]) if r[3] else {},
            "session_id": r[4],
        }
        for r in rows
    ]
