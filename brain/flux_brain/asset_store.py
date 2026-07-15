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

# WorkSpace isolation: assets + usage follow the project (same DB file), API
# keys stay global in ~/.flux/llm.json. None = global store.
_workspace: str | None = None


def set_workspace(path: str | None) -> dict[str, Any]:
    """Point the store at <path>/.flux/assets.db (None = back to global)."""
    global _workspace
    _workspace = str(path) if path else None
    conn = _ensure_db()
    count = conn.execute("SELECT COUNT(*) FROM assets").fetchone()[0]
    conn.close()
    return {"workspace": _workspace or "global", "asset_count": count}


def current_workspace() -> str | None:
    return _workspace


def _db_path() -> Path:
    if _workspace:
        d = Path(_workspace) / ".flux"
        d.mkdir(parents=True, exist_ok=True)
        return d / "assets.db"
    FLUX_DIR.mkdir(parents=True, exist_ok=True)
    return DB_PATH

# devready asset types (flywheel taxonomy). Free-form types are allowed;
# these are the ones the studio UI groups by.
ASSET_TYPES = (
    "register-map", "devicetree", "schematic-netlist", "test-plan",
    "hil-report", "triage-case", "sim-platform", "sim-scenario",
    "sim-report", "urdf", "characterization",
    "mission", "evidence-bundle", "bench-result", "devready",
    "fault-knowledge", "board-health", "dream-report",
)


def _ensure_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(_db_path()))
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
    conn.execute("""
        CREATE TABLE IF NOT EXISTS llm_usage (
            ts REAL,
            tool TEXT,
            tier TEXT,
            provider TEXT,
            model TEXT,
            prompt_tokens INTEGER,
            completion_tokens INTEGER
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


# ── Import / export — devready assets travel as JSON bundles ────────────────
# Bundle format: {"schema": "flux.assets/v1", "exported_at": ts, "assets": [envelope, ...]}

def export_assets(out_path: str, asset_id: str | None = None,
                  query: str | None = None, limit: int = 500) -> dict[str, Any]:
    """Write one asset (asset_id), matching assets (query), or the whole store
    to a portable JSON bundle. Returns {path, count}."""
    if asset_id:
        found = get_asset(asset_id)
        envelopes = [found] if found else []
    elif query:
        envelopes = [get_asset(h["id"]) for h in search_assets(query, limit=limit)]
        envelopes = [e for e in envelopes if e]
    else:
        conn = _ensure_db()
        rows = conn.execute("SELECT raw FROM assets ORDER BY ts LIMIT ?", (limit,)).fetchall()
        conn.close()
        envelopes = []
        for (raw,) in rows:
            try:
                envelopes.append(json.loads(raw))
            except json.JSONDecodeError:
                continue
    bundle = {"schema": "flux.assets/v1", "exported_at": time.time(),
              "workspace": _workspace or "global", "assets": envelopes}
    p = Path(os.path.expanduser(out_path))
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(bundle, ensure_ascii=False, indent=1))
    return {"path": str(p), "count": len(envelopes)}


def import_assets(in_path: str, overwrite: bool = True) -> dict[str, Any]:
    """Load a bundle (or a single bare envelope) back into the store.
    Returns {imported, skipped, ids}."""
    p = Path(os.path.expanduser(in_path))
    data = json.loads(p.read_text())
    envelopes = data.get("assets", [data]) if isinstance(data, dict) else data
    imported, skipped, ids = 0, 0, []
    for env in envelopes:
        if not isinstance(env, dict) or not env.get("type"):
            skipped += 1
            continue
        if not overwrite and env.get("asset_id") and get_asset(env["asset_id"]):
            skipped += 1
            continue
        ids.append(commit_asset(env))
        imported += 1
    return {"imported": imported, "skipped": skipped, "ids": ids[:50]}


# ── LLM usage metering — the routing-savings evidence line ──────────────────
# USD per 1M tokens. Overridable via ~/.flux/llm.json {"prices": {model: {in, out}}}.
_DEFAULT_PRICES: dict[str, dict[str, float]] = {
    "deepseek-v4-flash": {"in": 0.14, "out": 0.28},
    "deepseek-v4-pro": {"in": 0.55, "out": 2.19},
    "mimo-v2.5": {"in": 0.35, "out": 1.40},
}


def _load_prices() -> dict[str, dict[str, float]]:
    prices = dict(_DEFAULT_PRICES)
    try:
        with open(FLUX_DIR / "llm.json") as f:
            for model, p in json.load(f).get("prices", {}).items():
                prices[model] = {"in": float(p.get("in", 0)), "out": float(p.get("out", 0))}
    except (OSError, json.JSONDecodeError, ValueError, AttributeError):
        pass
    return prices


def record_usage(row: dict[str, Any]) -> None:
    """Append one LLM call's token usage. Never raises — metering must not break the call."""
    try:
        conn = _ensure_db()
        conn.execute(
            "INSERT INTO llm_usage VALUES (?,?,?,?,?,?,?)",
            (time.time(), str(row.get("tool", "")), str(row.get("tier", "")),
             str(row.get("provider", "")), str(row.get("model", "")),
             int(row.get("prompt_tokens", 0)), int(row.get("completion_tokens", 0))),
        )
        conn.commit()
        conn.close()
    except Exception:
        pass


def usage_stats(days: float = 7.0, since_ts: float | None = None) -> dict[str, Any]:
    """Aggregate token usage + routing-savings estimate.

    cost = actual spend at each model's price; baseline_cost = counterfactual
    "every call at the priciest known model" — saved_pct is the flywheel's
    cost-efficiency line on the dashboard.
    """
    cutoff = since_ts if since_ts is not None else time.time() - days * 86400
    conn = _ensure_db()
    rows = conn.execute(
        "SELECT tool, tier, provider, model, prompt_tokens, completion_tokens "
        "FROM llm_usage WHERE ts >= ?", (cutoff,)).fetchall()
    conn.close()
    prices = _load_prices()
    baseline = max(prices.values(), key=lambda p: p["in"] + p["out"], default={"in": 0.0, "out": 0.0})
    total_in = total_out = 0
    cost = baseline_cost = 0.0
    by_tier: dict[str, dict[str, int]] = {}
    for tool, tier, provider, model, p_tok, c_tok in rows:
        total_in += p_tok
        total_out += c_tok
        t = by_tier.setdefault(tier or "text", {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0})
        t["calls"] += 1
        t["prompt_tokens"] += p_tok
        t["completion_tokens"] += c_tok
        p = prices.get(model, baseline)
        cost += p_tok * p["in"] / 1e6 + c_tok * p["out"] / 1e6
        baseline_cost += p_tok * baseline["in"] / 1e6 + c_tok * baseline["out"] / 1e6
    saved_pct = round((1 - cost / baseline_cost) * 100, 1) if baseline_cost > 0 else 0.0
    return {
        "calls": len(rows), "total_in": total_in, "total_out": total_out,
        "by_tier": by_tier, "cost_usd": round(cost, 4),
        "baseline_cost_usd": round(baseline_cost, 4), "saved_pct": saved_pct,
    }


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
