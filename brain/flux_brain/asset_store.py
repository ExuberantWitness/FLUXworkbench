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

# devready asset types (flywheel taxonomy). Free-form types are allowed;
# these are the ones the studio UI groups by.
ASSET_TYPES = (
    "register-map", "devicetree", "schematic-netlist", "test-plan",
    "hil-report", "triage-case", "sim-platform", "sim-scenario",
    "sim-report", "urdf", "characterization",
)


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
    """Store an asset (envelope: asset_id/type/source/components/characterization/health).

    The `type` rides in the FTS tags column alongside component names, so both
    "register-map" and "UART0" hit in search. Returns the asset_id.
    """
    conn = _ensure_db()
    asset_type = event_data.get("type", "")
    asset_id = event_data.get(
        "asset_id", f"{asset_type or 'asset'}-{int(time.time())}"
    )
    components = json.dumps(event_data.get("components", []), ensure_ascii=False)
    char = json.dumps(event_data.get("characterization", {}), ensure_ascii=False)
    session = event_data.get("session", {})
    session_id = session.get("id", "")
    lineage = json.dumps(session.get("lineage", {}), ensure_ascii=False)
    raw = json.dumps(event_data, ensure_ascii=False)
    tags = " ".join([asset_type, *event_data.get("components", [])]).strip()

    conn.execute(
        "INSERT OR REPLACE INTO assets VALUES (?,?,?,?,?,?,?)",
        (asset_id, time.time(), components, char, session_id, lineage, raw),
    )
    # FTS index (delete-then-insert: INSERT OR REPLACE doesn't dedupe in fts5)
    conn.execute("DELETE FROM assets_fts WHERE id = ?", (asset_id,))
    conn.execute(
        "INSERT INTO assets_fts VALUES (?,?,?,?)",
        (asset_id, components, char, tags),
    )
    conn.commit()
    conn.close()
    return asset_id


def get_asset(asset_id: str) -> dict[str, Any] | None:
    """Fetch one asset's full envelope (the raw column) by id."""
    conn = _ensure_db()
    row = conn.execute(
        "SELECT raw FROM assets WHERE id = ?", (asset_id,)
    ).fetchone()
    conn.close()
    if row is None:
        return None
    return json.loads(row[0])


def list_assets(limit: int = 100) -> list[dict[str, Any]]:
    """List recent assets (id/ts/type/components), newest first — for the UI panel."""
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT id, ts, components, raw FROM assets ORDER BY ts DESC LIMIT ?",
        (limit,),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        try:
            raw = json.loads(r[3]) if r[3] else {}
        except json.JSONDecodeError:
            raw = {}
        out.append({
            "id": r[0],
            "ts": r[1],
            "type": raw.get("type", ""),
            "components": json.loads(r[2]) if r[2] else [],
            "source": raw.get("source", {}),
            "health": raw.get("health", {}),
        })
    return out


def update_health(asset_id: str, health: dict[str, Any]) -> bool:
    """Merge PHM health fields (last_verified, drift_notes) into an asset."""
    asset = get_asset(asset_id)
    if asset is None:
        return False
    merged = {**asset.get("health", {}), **health}
    asset["health"] = merged
    commit_asset(asset)
    return True


def _fts_quote(query: str) -> str:
    """Quote each token so FTS5 operators in plain text ('-', ':', '.') don't parse.
    Tokens are OR-joined (recall-oriented — natural-language chat messages must
    still hit assets); bm25 rank ordering keeps the best match first."""
    tokens = [t for t in query.replace('"', " ").split() if t]
    return " OR ".join(f'"{t}"' for t in tokens) or '""'


def search_assets(query: str, limit: int = 5) -> list[dict[str, Any]]:
    """Full-text search over committed assets. Returns matching asset dicts."""
    conn = _ensure_db()
    query = _fts_quote(query)
    rows = conn.execute(
        "SELECT a.id, a.ts, a.components, a.characterization, a.session_id, a.raw "
        "FROM assets_fts f JOIN assets a ON f.id = a.id "
        "WHERE assets_fts MATCH ? ORDER BY rank LIMIT ?",
        (query, limit),
    ).fetchall()
    conn.close()
    out = []
    for r in rows:
        try:
            raw = json.loads(r[5]) if r[5] else {}
        except json.JSONDecodeError:
            raw = {}
        out.append({
            "id": r[0],
            "ts": r[1],
            "type": raw.get("type", ""),
            "components": json.loads(r[2]) if r[2] else [],
            "characterization": json.loads(r[3]) if r[3] else {},
            "session_id": r[4],
        })
    return out
