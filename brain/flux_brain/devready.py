"""DevReady composer — assemble a self-describing BODY/MIND/JOURNAL asset.

Implements the FLUXmeme DevReady philosophy for dev boards: one asset that
any person or agent can pick up and start working from — structure (BODY),
development context and skills (MIND), and lifetime records (JOURNAL).

Everything gathered here is DETERMINISTIC: parsed from the SDK tree, the
board profile, and existing store assets. Nothing is invented by a model.
"""
from __future__ import annotations

import hashlib
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


# ── reference wiki-ization: official docs travel INSIDE the .flux file ──────
# Self-contained means offline-readable: a URL alone dies without network.

_WIKI_CAP = 15_000  # per-doc embedded markdown cap (chars)


def _html_to_md(html: str) -> str:
    """Dependency-free HTML → markdown-ish text (headings/lists/code kept)."""
    import html as htmllib
    html = re.sub(r"<(script|style|nav|footer|header)[^>]*>.*?</\1>", "",
                  html, flags=re.DOTALL | re.IGNORECASE)
    for i in (1, 2, 3):
        html = re.sub(
            rf"<h{i}[^>]*>(.*?)</h{i}>",
            lambda m, lvl=i: "\n" + "#" * lvl + " " + re.sub(r"<[^>]+>", "", m.group(1)).strip() + "\n",
            html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<pre[^>]*>(.*?)</pre>",
                  lambda m: "\n```\n" + re.sub(r"<[^>]+>", "", m.group(1)) + "\n```\n",
                  html, flags=re.DOTALL | re.IGNORECASE)
    html = re.sub(r"<li[^>]*>", "\n- ", html, flags=re.IGNORECASE)
    html = re.sub(r"<(br|/p|/div|/tr|/table)[^>]*>", "\n", html, flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", "", html)
    text = htmllib.unescape(text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    # nav debris: bullets/lines with no content
    text = re.sub(r"^\s*-\s*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[ \t]+$", "", text, flags=re.MULTILINE)
    text = re.sub(r"\n{3,}", "\n\n", text)
    # docs pages start with sidebar noise — begin at the first real heading
    m = re.search(r"^# .+$", text, flags=re.MULTILINE)
    if m and m.start() < len(text) // 2:
        text = text[m.start():]
    return text.strip()


def _wikify_references(refs: list[dict[str, Any]], prev: dict[str, Any] | None,
                       refresh: bool = False) -> list[dict[str, Any]]:
    """Embed fetched markdown into each reference. Previously embedded content
    is reused (compose runs after every mission — don't hammer the docs site);
    refresh=True refetches everything. Fetch failures keep the URL alone."""
    prev_by_url: dict[str, dict[str, Any]] = {}
    for r in ((prev or {}).get("characterization", {}).get("mind", {}).get("references", []) or []):
        if r.get("url") and r.get("content_md"):
            prev_by_url[r["url"]] = r
    out: list[dict[str, Any]] = []
    for ref in refs:
        url = ref.get("url", "")
        cached = prev_by_url.get(url)
        if cached and not refresh:
            out.append({**ref, "content_md": cached["content_md"],
                        "fetched_at": cached.get("fetched_at")})
            continue
        entry = dict(ref)
        if url.lower().endswith(".pdf"):
            entry["content_md"] = None
            entry["note"] = "PDF — use ingest_datasheet to extract registers"
        else:
            try:
                import httpx
                try:
                    resp = httpx.get(url, timeout=15, follow_redirects=True)
                except httpx.ConnectError:
                    # corporate/clash proxies MITM TLS — acceptable for docs
                    resp = httpx.get(url, timeout=15, follow_redirects=True, verify=False)
                    entry["note"] = "fetched with TLS verification disabled (proxy)"
                resp.raise_for_status()
                entry["content_md"] = _html_to_md(resp.text)[:_WIKI_CAP]
                entry["fetched_at"] = time.strftime("%Y-%m-%d %H:%M")
            except Exception as e:  # offline / 404 — keep the URL, note the miss
                entry["content_md"] = None
                entry["note"] = f"fetch failed: {str(e)[:80]}"
        out.append(entry)
    return out


def _host_env() -> dict[str, Any]:
    import platform
    env = {"os": platform.system().lower(), "arch": platform.machine(),
           "kernel": platform.release(), "python": platform.python_version()}
    try:
        env["distro"] = platform.freedesktop_os_release().get("PRETTY_NAME", "")
    except (OSError, AttributeError):
        env["distro"] = ""
    return env


def _load_profile(board: str, boards_json: str) -> dict[str, Any] | None:
    try:
        data = json.loads(Path(boards_json).read_text())
        for b in data.get("boards", []):
            if b.get("id") == board:
                return b
    except (OSError, json.JSONDecodeError):
        pass
    return None


def compose_devready(board: str, boards_json: str, serial: str | None = None,
                     refresh_wiki: bool = False) -> dict[str, Any]:
    """Aggregate profile + SDK scans + store assets into one devready asset.

    Identity: the asset_id is STABLE per board (devready-<board>) so recomposing
    always OVERWRITES rather than duplicates. A content fingerprint over the
    stable BODY facts detects when the underlying hardware description changed;
    an optional serial (chip UID read from a real probe) pins a physical
    instance. This is the real dedup — cooldown only stops rapid double-clicks.
    """
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
    # pin source: SDK pinmux (pinmap-) or a parsed PCB design (pcbmap-).
    pinmap = asset_store.get_asset(f"pinmap-{board}") or asset_store.get_asset(f"pcbmap-{board}")
    pin_ref = None
    if asset_store.get_asset(f"pinmap-{board}"):
        pin_ref = f"pinmap-{board}"
    elif asset_store.get_asset(f"pcbmap-{board}"):
        pin_ref = f"pcbmap-{board}"
    pchar = (pinmap or {}).get("characterization", {})
    pins = pchar.get("pins", [])
    body = {
        "chip": chip,
        "series": profile.get("name", ""),
        "arch": profile.get("arch", ""),
        "memory_map": parse_memory_map(ld_file),
        "boot_modes": _boot_modes(ld_dir),
        "pinmap": {"asset_ref": pin_ref, "pin_count": len(pins), "pins": pins},
        # schematic-level context from a PCB ingest (sensors/regulators the
        # firmware talks to, and the nets they sit on).
        "board_devices": pchar.get("board_devices", []),
        "key_nets": pchar.get("key_nets", []),
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
        # host environment this bring-up was validated on — reproduction context
        "host_env": _host_env(),
        "experience": (exp or {}).get("characterization", {}),
        "memory": memory,
        # Authoritative external docs travel WITH the asset — wiki-ized:
        # the fetched markdown is embedded so the pack reads offline. Cached
        # from the previous composition unless refresh_wiki is set.
        "references": _wikify_references(
            profile.get("references", []),
            asset_store.get_asset(f"devready-{board}"), refresh=refresh_wiki),
        "agent_skills": [
            {"tool": "gen_test_plan", "for": "asset-driven HIL test plans"},
            {"tool": "ingest_pinmux", "for": "refresh pin map from SDK"},
            {"tool": "flux:build", "for": "cross-compile via studio kernel"},
            {"tool": "flux:hilRun", "for": "flash + verify on mock/sim/real"},
            {"tool": "export_asset / import_asset", "for": "carry this DevReady pack to another machine"},
        ],
    }

    # ── JOURNAL: lifetime records EMBEDDED, not just linked — whoever holds
    # the .flux file sees what happened to this board without the store. ──
    linked: dict[str, list[str]] = {"missions": [], "hil_reports": [], "triage_cases": [], "evidence": []}
    history: list[dict[str, Any]] = []
    for hit in asset_store.search_assets(board, limit=50):
        t = hit.get("type", "")
        if t == "mission":
            linked["missions"].append(hit["id"])
            rec = asset_store.get_asset(hit["id"]) or {}
            rc = rec.get("characterization", {})
            history.append({
                "kind": "mission", "id": hit["id"],
                "goal": str(rc.get("goal", ""))[:120],
                "verdict": rc.get("verdict"),
                "time_to_devready_ms": rc.get("time_to_devready_ms"),
                "asset_hits": rc.get("asset_hits"), "tool_calls": rc.get("tool_calls"),
            })
        elif t == "hil-report":
            linked["hil_reports"].append(hit["id"])
            rec = asset_store.get_asset(hit["id"]) or {}
            summ = rec.get("characterization", {}).get("summary", {})
            history.append({"kind": "hil-report", "id": hit["id"],
                            "verdict": summ.get("verdict"),
                            "passed": summ.get("passed"), "total": summ.get("total")})
        elif t == "triage-case":
            linked["triage_cases"].append(hit["id"])
            rec = asset_store.get_asset(hit["id"]) or {}
            rc = rec.get("characterization", {})
            fixes = rc.get("suggested_fixes", [])
            history.append({"kind": "triage", "id": hit["id"],
                            "category": rc.get("category"),
                            "root_cause": str(rc.get("root_cause", ""))[:160],
                            "fix": fixes[0].get("title", "") if fixes else ""})
        elif t == "evidence-bundle":
            linked["evidence"].append(hit["id"])
    history = history[-30:]  # cap: latest 30 records travel with the file
    journal = {
        "history": history,
        "linked_records": linked,
        "health": {"last_verified": time.strftime("%Y-%m-%d %H:%M"),
                   "verification": "characterized (pin map); firmware HIL pending real-probe run",
                   "drift_notes": []},
    }

    # ── identity: stable key + content fingerprint (+ optional instance serial) ──
    fp_basis = {
        "chip": chip, "arch": profile.get("arch", ""),
        "pin_count": len(pins),
        "memory": [(r["region"], r["origin"]) for r in body["memory_map"]],
        "boot_modes": body["boot_modes"],
    }
    fingerprint = hashlib.sha256(
        json.dumps(fp_basis, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]
    identity = {
        "key": f"devready-{board}",   # stable — recompose overwrites
        "board": board, "chip": chip,
        "fingerprint": fingerprint,   # changes only if the hardware facts change
        "serial": serial,             # chip UID from a real probe, or None
    }

    envelope = {
        "schema": "flux.devready/v1",
        "asset_id": f"devready-{board}",
        "type": "devready",
        "identity": identity,
        "source": {"kind": "devready-compose", "board": board,
                   "spec": "FLUXmeme DevReady (BODY/MIND/JOURNAL)"},
        # components feed the asset card title line — board identity ONLY.
        # SDK-shipped optional kernels live in mind.rtos (they are NOT what the
        # board is running; showing them here misled users).
        "components": [board, chip],
        "characterization": {"identity": identity, "body": body, "mind": mind, "journal": journal},
        "health": journal["health"],
    }
    asset_id = asset_store.commit_asset(envelope)

    # ── land the real .flux file (self-contained, explorer-findable) ──
    flux_dir = Path(asset_store._db_path()).parent / "devready"
    flux_dir.mkdir(parents=True, exist_ok=True)
    flux_path = flux_dir / f"{board}.flux"
    flux_path.write_text(json.dumps(envelope, ensure_ascii=False, indent=1))
    stale = flux_dir / f"{board}.flux.json"
    if stale.exists():
        stale.unlink()

    return {"asset_id": asset_id, "type": "devready", "fingerprint": fingerprint,
            "flux_path": str(flux_path),
            "body_pins": len(pins), "memory_regions": len(body["memory_map"]),
            "boot_modes": len(body["boot_modes"]),
            "geometry": bool(body["geometry"].get("usd_ref") or body["geometry"].get("dimensions_mm")),
            "rtos_available": [r["name"] for r in mind["rtos"].get("available", [])],
            "memory_lessons": len(memory), "references": len(mind["references"]),
            "journal_links": {k: len(v) for k, v in linked.items()}}


def add_board_lesson(board: str, symptom: str, fix: str, boards_json: str) -> dict[str, Any]:
    """UI entry for modular memory: append a lesson to the board's experience
    asset, then recompose so the .flux file carries it immediately."""
    if not symptom.strip():
        return {"error": "symptom is required"}
    aid = f"experience-{board}-bringup"
    exp = asset_store.get_asset(aid) or {
        "asset_id": aid, "type": "characterization",
        "source": {"kind": "dev-experience", "board": board},
        "components": [board], "characterization": {}}
    c = exp.setdefault("characterization", {})
    lessons = c.setdefault("lessons", [])
    lessons.append({"symptom": symptom.strip()[:300], "fix": fix.strip()[:300],
                    "date": time.strftime("%Y-%m-%d"), "via": "studio-ui"})
    asset_store.commit_asset(exp)
    out = compose_devready(board, boards_json)
    return {"asset_id": out.get("asset_id", f"devready-{board}"),
            "lessons": len(lessons), "recomposed": "error" not in out}
