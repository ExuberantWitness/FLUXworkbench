"""Dream — the memory sub-agent (nightly asset consolidation).

The flywheel's write side accumulates raw material (triage cases, HIL
reports, duplicate ingests); dream distills it into reusable knowledge:

  1. triage-case merge     — ≥3 cases of a category → fault-knowledge-<cat>
  2. board health          — hil-reports per board → pass rate / failure
                             streak / last_verified → board-health-<board>
  3. usage rollup          — llm_usage rows older than 30 days → daily
                             aggregates, raw rows deleted
  4. dedup                 — same (type, source.sha256) → older ones marked
                             superseded (marked, never deleted)
  5. dream-report-<ts>     — what happened, committed as an asset

Deterministic computation first; the only LLM use is the optional
`summarize` callable (light tier) for merging root-cause text.
"""
from __future__ import annotations

import json
import time
from collections import defaultdict
from typing import Any, Callable

from . import asset_store

KEEP_RECENT_CASES = 10   # newest cases stay unconsolidated for fresh triage context
USAGE_RAW_DAYS = 30


def _load_assets() -> list[dict[str, Any]]:
    conn = asset_store._ensure_db()
    rows = conn.execute("SELECT id, ts, raw FROM assets ORDER BY ts").fetchall()
    conn.close()
    out: list[dict[str, Any]] = []
    for aid, ts, raw in rows:
        try:
            a = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            continue
        a["_id"], a["_ts"] = aid, ts
        out.append(a)
    return out


def _recommit(asset: dict[str, Any], **patch: Any) -> None:
    """Re-commit an asset with flags patched; underscore keys stripped."""
    envelope = {k: v for k, v in asset.items() if not k.startswith("_")}
    envelope.setdefault("asset_id", asset["_id"])
    envelope.update(patch)
    asset_store.commit_asset(envelope)


def consolidate(dry_run: bool = False,
                summarize: Callable[[str], str] | None = None) -> dict[str, Any]:
    report: dict[str, Any] = {
        "dry_run": dry_run, "merged_categories": [], "boards": [],
        "superseded": [], "usage_days_rolled": 0, "started": time.time(),
    }
    assets = _load_assets()

    # ── 1. fault knowledge: merge triage cases per category ──
    cases = [a for a in assets if a.get("type") == "triage-case"]
    by_cat: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for c in cases:
        by_cat[(c.get("characterization") or {}).get("category", "unknown")].append(c)
    for cat, group in sorted(by_cat.items()):
        if len(group) < 3:
            continue
        causes = [(g.get("characterization") or {}).get("root_cause", "") for g in group]
        knowledge = ""
        if summarize is not None:
            prompt = (
                f"Merge these firmware fault root-cause hypotheses (category: {cat}) into ONE "
                "concise knowledge entry (<=120 words): the recurring pattern and what fixed it.\n- "
                + "\n- ".join(c[:200] for c in causes[-12:] if c))
            try:
                knowledge = (summarize(prompt) or "")[:1200]
            except Exception:
                knowledge = ""
        if not knowledge:
            knowledge = f"{len(group)} cases on record; latest: {causes[-1][:200]}"
        report["merged_categories"].append({"category": cat, "cases": len(group)})
        if dry_run:
            continue
        asset_store.commit_asset({
            "asset_id": f"fault-knowledge-{cat}",
            "type": "fault-knowledge",
            "source": {"kind": "dream", "cases": len(group)},
            "components": [cat],
            "characterization": {
                "category": cat, "cases": len(group), "knowledge": knowledge,
                "case_ids": [g["_id"] for g in group][-20:],
            },
        })
        for g in group[:-KEEP_RECENT_CASES]:
            if not g.get("consolidated"):
                _recommit(g, consolidated=True)

    # ── 2. board health from HIL reports (deterministic PHM) ──
    hil = [a for a in assets if a.get("type") == "hil-report"]
    by_board: dict[str, list[dict[str, Any]]] = defaultdict(list)
    for r in hil:
        by_board[str((r.get("source") or {}).get("board", "?"))].append(r)
    for board, group in sorted(by_board.items()):
        verdicts = [((g.get("characterization") or {}).get("summary") or {}).get("verdict", "?")
                    for g in group]
        passed = sum(v == "PASS" for v in verdicts)
        streak = 0
        for v in reversed(verdicts):
            if v != "PASS":
                streak += 1
            else:
                break
        entry = {
            "board": board, "runs": len(group),
            "pass_rate": round(passed / len(group), 3),
            "consecutive_failures": streak,
            "last_verified": group[-1]["_ts"],
        }
        report["boards"].append(entry)
        if dry_run:
            continue
        asset_store.commit_asset({
            "asset_id": f"board-health-{board}",
            "type": "board-health",
            "source": {"kind": "dream"},
            "components": [board],
            "characterization": entry,
            "health": {"last_verified": group[-1]["_ts"],
                       "drift_notes": f"failure streak {streak}" if streak else ""},
        })
        asset_store.update_health(group[-1]["_id"], {"last_verified": group[-1]["_ts"]})

    # ── 3. usage rollup: raw rows older than 30 days → daily aggregates ──
    cutoff = time.time() - USAGE_RAW_DAYS * 86400
    conn = asset_store._ensure_db()
    old = conn.execute(
        "SELECT CAST(ts/86400 AS INT) AS d, COUNT(*), SUM(prompt_tokens), SUM(completion_tokens) "
        "FROM llm_usage WHERE ts < ? GROUP BY d ORDER BY d", (cutoff,)).fetchall()
    rollup = [{"day": d, "calls": c, "prompt_tokens": pi or 0, "completion_tokens": co or 0}
              for d, c, pi, co in old]
    report["usage_days_rolled"] = len(rollup)
    if not dry_run and rollup:
        conn.execute("DELETE FROM llm_usage WHERE ts < ?", (cutoff,))
        conn.commit()
    conn.close()

    # ── 4. dedup: same (type, source.sha256) → older marked superseded ──
    by_sha: dict[tuple[str, str], list[dict[str, Any]]] = defaultdict(list)
    for a in assets:
        sha = (a.get("source") or {}).get("sha256")
        if sha and a.get("type"):
            by_sha[(str(a["type"]), str(sha))].append(a)
    for (_typ, _sha), group in by_sha.items():
        if len(group) < 2:
            continue
        group.sort(key=lambda g: g["_ts"])
        for g in group[:-1]:
            if g.get("superseded"):
                continue
            report["superseded"].append(g["_id"])
            if not dry_run:
                _recommit(g, superseded=True)

    # ── 5. the dream report itself becomes an asset ──
    report["duration_s"] = round(time.time() - report["started"], 2)
    if not dry_run:
        asset_store.commit_asset({
            "asset_id": f"dream-report-{int(time.time())}",
            "type": "dream-report",
            "source": {"kind": "dream"},
            "components": [str(len(report["merged_categories"])) + "cats",
                           str(len(report["boards"])) + "boards"],
            "characterization": report,
        })
    return report
