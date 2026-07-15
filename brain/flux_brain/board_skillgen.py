"""Board skill generator — turn a board's .flux DevReady asset into a set of
agent skills (Luxonis-style: setup → interview → build → troubleshoot).

The insight: a DevReady asset is already the domain knowledge an agent needs.
This composer PROJECTS it into SKILL.md files that Claude Code / Cursor / Codex
can invoke. Deterministic template fill — every fact comes from the .flux
asset, nothing is invented. SkillOpt-style iteration: because the asset's
JOURNAL and MEMORY grow with use, regenerating produces sharper skills over
time (the troubleshoot skill literally learns from accumulated triage cases).
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from . import asset_store


def _fm(name: str, description: str) -> str:
    """SKILL.md frontmatter block."""
    return f"---\nname: {name}\ndescription: {description}\n---\n\n"


def _guide_skill(board: str, chip: str, name: str, skills: list[str]) -> str:
    lines = [_fm(f"{board}-guide",
                 f"Navigation entry for working with the {name} ({chip}) board. "
                 f"Not sure where to start? Run this — it points to the right {board} skill.")]
    lines.append(f"# {name} — Guide\n")
    lines.append(f"You are working with a **{name}** ({chip}) board. Its full DevReady "
                 f"context lives in `~/.flux/devready/{board}.flux` (structure, pin map, "
                 f"memory map, RTOS, build/flash howto, debugging memory, official docs, "
                 f"operation history). Read it first — it is the authoritative source.\n")
    lines.append("## Pick a skill\n")
    lines.append(f"1. **`/{board}-setup`** — bring the board to a verified-usable state "
                 "(detect probe → authorize USB → connect).")
    lines.append(f"2. **`/{board}-interview`** — turn your idea into a PROJECT_BRIEF.md.")
    lines.append(f"3. **`/{board}-build`** — cross-compile + flash + verify on the real board.")
    lines.append(f"4. **`/{board}-troubleshoot`** — something broke? Isolate and fix, "
                 "learning from this board's accumulated fault history.\n")
    lines.append(f"Typical first run: `/{board}-setup` → `/{board}-interview` → `/{board}-build`.")
    return "\n".join(lines) + "\n"


def _setup_skill(board: str, chip: str, name: str, dr: dict[str, Any]) -> str:
    body = dr.get("body", {})
    usb = body.get("debug_topology", {}).get("probe", {})
    console = body.get("console", {})
    mind = dr.get("mind", {})
    ocd = mind.get("flash_debug_howto", {})
    s = _fm(f"{board}-setup",
            f"Bring a {name} ({chip}) board to a verified-usable state: detect the "
            f"debug probe, authorize USB access, connect via OpenOCD. Writes DEVICE.md.")
    out = [s, f"# {name} — Device Setup\n"]
    out.append("Goal: from a board in the box to a connected, verified probe.\n")
    out.append("## In FluxStudio (preferred — no terminal)\n")
    out.append("Real tab → **Devices** → ↻ Scan → 🔓 Authorize (system password dialog) "
               "→ Connect. The physical subagent flips to REAL on success.\n")
    out.append("## Facts (from the .flux asset)\n")
    out.append(f"- Debug probe: **{usb.get('label', '?')}** — USB `{usb.get('vid','?')}:{usb.get('pid','?')}`")
    out.append(f"- Transport: {body.get('debug_topology', {}).get('transport', '?')}, "
               f"TAP id `{body.get('debug_topology', {}).get('tap_id', '?')}`")
    out.append(f"- Flash driver: `{body.get('debug_topology', {}).get('flash_driver', '?')}`")
    out.append(f"- Console: `{console.get('dev_hint','?')}` @ {console.get('baud','?')} baud\n")
    out.append("## Manual path (if not using studio)\n")
    out.append("```bash")
    out.append(f"# 1. authorize the probe (udev rule, one-time)")
    out.append(f"echo 'SUBSYSTEM==\"usb\", ATTRS{{idVendor}}==\"{usb.get('vid','')}\", "
               f"ATTRS{{idProduct}}==\"{usb.get('pid','')}\", MODE=\"0666\", TAG+=\"uaccess\"' \\")
    out.append(f"  | sudo tee /etc/udev/rules.d/99-flux-{usb.get('vid','')}-{usb.get('pid','')}.rules")
    out.append("sudo udevadm control --reload-rules && sudo udevadm trigger")
    out.append(f"# 2. connect")
    cfgs = " ".join(f"-f {c}" for c in ocd.get("cfgs", []))
    out.append(f"{ocd.get('openocd_bin','openocd')} -s {ocd.get('openocd_search','')} {cfgs}")
    out.append("```\n")
    out.append("On success, save a **DEVICE.md** noting the working probe path + config, "
               "so the next session starts from a known-good state.")
    return "\n".join(out) + "\n"


def _interview_skill(board: str, chip: str, name: str, dr: dict[str, Any]) -> str:
    mind = dr.get("mind", {})
    rtos = mind.get("rtos", {})
    avail = ", ".join(r["name"] for r in rtos.get("available", [])) or "bare-metal only"
    s = _fm(f"{board}-interview",
            f"Turn your idea for the {name} ({chip}) into an executable PROJECT_BRIEF.md "
            "through a plain-language interview (one question at a time).")
    out = [s, f"# {name} — Project Interview\n"]
    out.append("Interview the user ONE question at a time, then write PROJECT_BRIEF.md.\n")
    out.append("## Board capabilities to ground the questions (from .flux)\n")
    out.append(f"- Chip: **{chip}**, {body_arch(dr)}")
    out.append(f"- RTOS available: {avail} (default: {rtos.get('default_runtime','bare-metal')})")
    out.append(f"- On-chip memory regions: {', '.join(r['region'] for r in dr.get('body', {}).get('memory_map', [])[:6])}")
    out.append(f"- SDK samples on disk: {mind.get('sdk', {}).get('sample_count', '?')}\n")
    out.append("## Questions (adapt, don't dump)\n")
    out.append("1. What should the board DO? (one sentence)")
    out.append("2. Which peripherals/pins are involved? (point them at the pin map in the .flux)")
    out.append("3. Bare-metal or an RTOS? If RTOS, which of the available kernels?")
    out.append("4. What is the success signal — how will we know it works on the real board?")
    out.append("5. Any timing/memory constraints?\n")
    out.append("Write **PROJECT_BRIEF.md**: goal, peripherals, runtime choice, success "
               "signal, constraints, and the closest SDK sample to adapt.")
    return "\n".join(out) + "\n"


def body_arch(dr: dict[str, Any]) -> str:
    return dr.get("body", {}).get("arch", "")


def _build_skill(board: str, chip: str, name: str, dr: dict[str, Any]) -> str:
    mind = dr.get("mind", {})
    howto = mind.get("build_howto", {})
    tc = mind.get("toolchain", {})
    s = _fm(f"{board}-build",
            f"Cross-compile, flash and verify firmware on the real {name} ({chip}) board. "
            "Adapts the closest verified SDK sample rather than inventing a pipeline.")
    out = [s, f"# {name} — Build & Flash\n"]
    out.append("Never invent a build from memory — adapt the closest verified sample.\n")
    out.append("## In FluxStudio\n")
    out.append("Asset card → **Build** tab → ▶ Build. Then HIL flash step on the Real tab.\n")
    out.append("## Toolchain (from .flux)\n")
    out.append(f"- Toolchain env: `{tc.get('env','?')}` → glob `{tc.get('path_glob','?')}`")
    out.append(f"- SDK: `{mind.get('sdk', {}).get('env','?')}` = `{mind.get('sdk', {}).get('path','?')}`")
    if tc.get("provision"):
        out.append(f"- Provision notes: {tc['provision']}")
    out.append("")
    out.append("## Build command\n```bash")
    out.append(f"cd {howto.get('sample_entry','<sample>')}")
    out.append(f"{howto.get('command','cmake -GNinja .. && ninja')}")
    out.append("```\n")
    out.append("Then flash + verify (studio HIL, or openocd program). Confirm the console "
               f"({dr.get('body', {}).get('console', {}).get('dev_hint','?')}) shows the expected output.")
    return "\n".join(out) + "\n"


def _troubleshoot_skill(board: str, chip: str, name: str, dr: dict[str, Any]) -> str:
    mind = dr.get("mind", {})
    memory = mind.get("memory", [])
    journal = dr.get("journal", {})
    s = _fm(f"{board}-troubleshoot",
            f"'It broke' entry for the {name} ({chip}): reproduce, isolate device-vs-app, "
            "change one variable at a time — grounded in this board's real fault history.")
    out = [s, f"# {name} — Troubleshoot\n"]
    out.append("Reproduce → isolate (device vs app) → diff against a known-good sample → "
               "change ONE variable at a time until the symptom clears.\n")
    out.append("## Known failure modes on THIS board (learned, not guessed)\n")
    if memory:
        for m in memory[:12]:
            sym = m.get("symptom", "")
            fix = m.get("fix", "")
            origin = m.get("origin", "")
            out.append(f"- **{sym[:120]}**\n  → {fix[:160]} _[{origin}]_")
    else:
        out.append("- (no fault history yet — it will accumulate as you use the board)")
    out.append("")
    hist = journal.get("history", [])
    triages = [h for h in hist if h.get("kind") == "triage"]
    if triages:
        out.append(f"## Recent triage cases ({len(triages)})\n")
        for tc in triages[-6:]:
            out.append(f"- [{tc.get('category','?')}] {tc.get('root_cause','')[:120]} → {tc.get('fix','')[:100]}")
        out.append("")
    out.append("## Official docs (embedded offline in the .flux)\n")
    for r in mind.get("references", []):
        has = "📄 embedded" if r.get("content_md") else "🔗 link only"
        out.append(f"- {has} — {r.get('title','')}: {r.get('url','')}")
    out.append("\nIf you can't fix it locally, generate a SUPPORT_PACKET.md "
               "(the .flux asset + the failing command + observed vs expected).")
    return "\n".join(out) + "\n"


def generate_board_skills(board: str, out_dir: str | None = None) -> dict[str, Any]:
    """Read the board's devready asset → write a skill pack. Returns paths."""
    asset = asset_store.get_asset(f"devready-{board}")
    if not asset:
        return {"error": f"no devready asset for '{board}' — run compose_devready first"}
    dr = asset.get("characterization", {})
    chip = dr.get("body", {}).get("chip") or asset.get("identity", {}).get("chip", "")
    name = dr.get("body", {}).get("series") or board

    ids = [f"{board}-guide", f"{board}-setup", f"{board}-interview",
           f"{board}-build", f"{board}-troubleshoot"]
    docs = {
        f"{board}-guide": _guide_skill(board, chip, name, ids),
        f"{board}-setup": _setup_skill(board, chip, name, dr),
        f"{board}-interview": _interview_skill(board, chip, name, dr),
        f"{board}-build": _build_skill(board, chip, name, dr),
        f"{board}-troubleshoot": _troubleshoot_skill(board, chip, name, dr),
    }

    base = Path(out_dir) if out_dir else Path(asset_store._db_path()).parent / "skills" / board
    written = []
    for sid, content in docs.items():
        d = base / sid
        d.mkdir(parents=True, exist_ok=True)
        (d / "SKILL.md").write_text(content)
        written.append(str(d / "SKILL.md"))

    # A tiny marketplace-style manifest so the pack is installable/portable.
    (base / "skills.json").write_text(json.dumps({
        "schema": "flux.skillpack/v1", "board": board, "chip": chip,
        "source_asset": f"devready-{board}",
        "skills": [{"name": sid, "path": f"{sid}/SKILL.md"} for sid in ids],
    }, ensure_ascii=False, indent=1))

    return {"board": board, "chip": chip, "skill_dir": str(base),
            "skills": ids, "files": written,
            "memory_lessons": len(dr.get("mind", {}).get("memory", [])),
            "note": "regenerate after more bring-ups — troubleshoot skill sharpens as fault history grows"}
