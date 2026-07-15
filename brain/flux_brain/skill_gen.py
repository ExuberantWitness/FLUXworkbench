"""Board skill-pack generator — project a DevReady .flux asset into agent
skills (Luxonis-OAK style, SkillOpt-informed).

The .flux file IS the context anchor (their llms.txt + examples repo, in one
file). Each generated SKILL.md is a compact, deployable artifact whose facts
are pulled from the asset — build commands, probe configs, serial settings,
and the debugging MEMORY (lessons auto-accumulated from triage/dream). Every
regeneration folds the latest lessons into the troubleshoot skill: a light,
deterministic version of SkillOpt's reflect→update loop (validation-gated
LLM editing can layer on later).

Pack layout (per board):
  <board>-guide         navigation entry: which skill, when
  <board>-setup         plug → authorize → probe-verified state
  <board>-build-poc     adapt nearest SDK sample → build → flash → serial proof
  <board>-troubleshoot  known-issues table + isolate/diff/one-variable loop
  flux-project-interview (shared) idea → PROJECT_BRIEF.md
"""
from __future__ import annotations

import json
import os
import shutil
import time
from pathlib import Path
from typing import Any

from . import asset_store


def _flux_path(board: str) -> Path:
    return Path(asset_store._db_path()).parent / "devready" / f"{board}.flux"


def _load_flux(board: str) -> dict[str, Any] | None:
    p = _flux_path(board)
    if p.exists():
        try:
            return json.loads(p.read_text())
        except json.JSONDecodeError:
            return None
    return asset_store.get_asset(f"devready-{board}")


def _fm(name: str, description: str) -> str:
    return f"---\nname: {name}\ndescription: {description}\n---\n\n"


def _lessons_table(mind: dict[str, Any]) -> str:
    rows = []
    for m in mind.get("memory", [])[:12]:
        sym = str(m.get("symptom", "")).replace("|", "/")[:90]
        fix = str(m.get("fix", "")).replace("|", "/")[:90]
        if sym:
            rows.append(f"| {sym} | {fix} | {m.get('origin', '')} |")
    if not rows:
        return "(no recorded lessons yet — this table grows automatically)\n"
    return "| symptom | fix | origin |\n|---|---|---|\n" + "\n".join(rows) + "\n"


def generate_skills(board: str, install: bool = False,
                    repo_root: str | None = None) -> dict[str, Any]:
    flux = _load_flux(board)
    if not flux:
        return {"error": f"no devready asset for '{board}' — run compose_devready first"}
    c = flux.get("characterization", {})
    body, mind = c.get("body", {}), c.get("mind", {})
    bh = mind.get("build_howto", {})
    fd = mind.get("flash_debug_howto", {})
    tc = mind.get("toolchain", {})
    sdk = mind.get("sdk", {})
    usb = body.get("debug_topology", {}).get("probe", {})
    con = body.get("console", {})
    chip = body.get("chip", board)
    fluxfile = str(_flux_path(board))
    refs = "\n".join(f"- {r.get('title')}: {r.get('url')}" for r in mind.get("references", [])[:6])
    rtos = mind.get("rtos", {})
    rtos_line = ", ".join(a.get("name", "") for a in rtos.get("available", [])) or "none found"

    skills: dict[str, str] = {}

    # ── guide ──
    skills[f"{board}-guide"] = _fm(
        f"{board}-guide",
        f"{body.get('series', board)} 技能导航：不知道从哪开始时先跑这个。列出 setup/build-poc/troubleshoot 该用哪个。用户说\"{board}\"、\"这块板怎么用\"时使用。",
    ) + f"""# {board} — Agent Skill Pack Guide

**Context anchor (read this FIRST, it is self-contained):** `{fluxfile}`
That .flux file carries: pin map ({body.get('pinmap', {}).get('pin_count', '?')} pins), memory map,
boot modes, RTOS state ({rtos_line}), build/flash howto, debugging memory
(lessons), offline copies of the official docs, and the board's full
operation history. Prefer it over guessing or web search.

## Which skill, when
- `/{board}-setup` — board in hand → probe-verified state. Run once per machine/session.
- `/flux-project-interview` — turn the idea into PROJECT_BRIEF.md before building.
- `/{board}-build-poc` — smallest runnable demo on the real board, adapted from SDK samples.
- `/{board}-troubleshoot` — anything broken: build errors, probe not found, no serial output.

## Rules for the agent
1. Facts come from the .flux file, not memory. Cite it.
2. Never invent register addresses or pin functions — query the pinmap/memory_map inside .flux.
3. One variable at a time when debugging; record new lessons back (commit_asset experience-{board}-bringup or via FluxStudio).
"""

    # ── setup ──
    udev_lesson = next((m for m in mind.get("memory", []) if "udev" in str(m.get("fix", ""))), None)
    skills[f"{board}-setup"] = _fm(
        f"{board}-setup",
        f"把 {board} 从开箱带到探针验证可用状态：USB 检测、权限授权、OpenOCD 连接、串口确认。用户说\"连接/调通/识别 {board}\"时使用。",
    ) + f"""# {board} — Device Setup (to a VERIFIED state)

Target