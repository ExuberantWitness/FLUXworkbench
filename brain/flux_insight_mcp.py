#!/usr/bin/env python3
"""Flux-Insight MCP server — conductor agent for the pipeline.

Replaces the old brain-agent (bus_ipc.py). Runs as an MCP server,
exposing tools that the kernel orchestrator calls. Flux-Insight
drives the 4-phase pipeline (asset_construct → calibrate → policy → deploy).

MCP protocol: JSON-RPC 2.0 over stdio (one JSON object per line).
"""
import json
import sys
import os
import logging
from typing import Any

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
log = logging.getLogger("flux_insight")

# flux_brain is editable-installed in brain/.venv; fall back to sibling path
# so the server also works when launched with a bare python3.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
# fluxweave_core is imported lazily inside its two tool handlers below: it pulls
# in numpy + a vendored stl_metadata, and a missing heavy/optional dep must NOT
# take down the other 38 tools (chat, guide_match, …) at server startup.
from flux_brain import asset_store, board_skillgen, chip_bind, codegen, devready, dts_ingest, onboard, pcb_ingest, pdf_ingest, pinmux_ingest, repl_gen, svd_ingest  # noqa: E402
from flux_brain.llm_ollama import SCHEMATIC_PROMPT  # noqa: E402
from flux_brain.llm_vllm import _data_url  # noqa: E402


def _extract_json(text: str) -> Any:
    """Strip markdown fences and parse JSON; raises ValueError on failure."""
    raw = text.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    # Fall back to the outermost {...} span (models love prose around JSON)
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start, end = raw.find("{"), raw.rfind("}")
        if start >= 0 and end > start:
            return json.loads(raw[start:end + 1])
        raise ValueError(f"no JSON found in LLM output: {raw[:200]}")

# ── Multi-provider LLM: separate text and vision channels ──
# Defaults: local vLLM for both. ~/.flux/llm.json overrides per channel
# (keys stay machine-local, never in the repo); set_api_config switches at runtime.
_config = {
    "provider": os.environ.get("FLUX_LLM_PROVIDER", "vllm"),
    "endpoint": os.environ.get("FLUX_LLM_ENDPOINT", "http://127.0.0.1:8000"),
    "api_key": os.environ.get("FLUX_LLM_API_KEY", ""),
    "model": os.environ.get("FLUX_LLM_MODEL", "openbmb/MiniCPM-V-4.6"),
    "_tier": "text",
}
_vision_config = {**_config, "_tier": "vision"}
# Tiered routing (PilotDeck-style difficulty classification, own implementation):
# light tier for cheap/mechanical calls, heavy tier for structured generation.
_tiers: dict[str, dict[str, str]] = {}


def _load_llm_json() -> None:
    cfg_path = os.path.join(os.path.expanduser(os.environ.get("FLUX_HOME", "~/.flux")), "llm.json")
    try:
        with open(cfg_path) as f:
            file_cfg = json.load(f)
    except (OSError, json.JSONDecodeError):
        return
    for key, target in (("text", _config), ("vision", _vision_config)):
        for k, v in file_cfg.get(key, {}).items():
            if k in target:
                target[k] = str(v)
    for tier, cfg in file_cfg.get("tiers", {}).items():
        _tiers[tier] = {**_config, **{k: str(v) for k, v in cfg.items()}, "_tier": tier}
    log.info(f"llm.json loaded: text={_config['provider']}/{_config['model']} "
             f"vision={_vision_config['provider']}/{_vision_config['model']} "
             f"tiers={[f'{t}:{c['model']}' for t, c in _tiers.items()]}")


def _save_llm_json() -> None:
    """Persist the current text/vision channels to ~/.flux/llm.json so the
    provider + API key survive a restart (keys stay machine-local, never in the
    repo). Preserves any existing `tiers` block."""
    home = os.path.expanduser(os.environ.get("FLUX_HOME", "~/.flux"))
    cfg_path = os.path.join(home, "llm.json")
    try:
        existing: dict[str, Any] = {}
        try:
            with open(cfg_path) as f:
                existing = json.load(f)
        except (OSError, json.JSONDecodeError):
            existing = {}
        keys = ("provider", "endpoint", "api_key", "model")
        existing["text"] = {k: _config[k] for k in keys}
        existing["vision"] = {k: _vision_config[k] for k in keys}
        os.makedirs(home, exist_ok=True)
        with open(cfg_path, "w") as f:
            json.dump(existing, f, indent=2, ensure_ascii=False)
        log.info(f"persisted llm.json: text={_config['provider']}/{_config['model']}")
    except OSError as e:
        log.warning(f"could not persist llm.json: {e}")


_load_llm_json()

# Tools that produce schema-constrained artifacts get the heavy tier by default.
_HEAVY_TOOLS = {"gen_test_plan", "characterize", "design_urdf", "design_reward", "identify_gap"}


def _route(tool: str, prompt: str) -> dict[str, str]:
    """Pick the model config for a text call: tool class first, prompt size second."""
    if not _tiers:
        return _config
    tier = "heavy" if (tool in _HEAVY_TOOLS or len(prompt) > 6000) else "light"
    cfg = _tiers.get(tier, _config)
    log.info(f"route: {tool} -> {tier} ({cfg['model']}, prompt={len(prompt)}ch)")
    return cfg

STOP_TOKEN_IDS = [248044, 248046]


def _record_usage(tool: str, cfg: dict[str, str], data: dict[str, Any], model: str = "") -> None:
    """Metering hook (P0.3): pull the usage block every provider already returns
    and persist it. Anthropic uses input/output_tokens, OpenAI-compat prompt/completion.
    Must never break the call — swallow everything."""
    try:
        u = data.get("usage") or {}
        asset_store.record_usage({
            "tool": tool, "tier": cfg.get("_tier", "text"),
            "provider": cfg.get("provider", ""), "model": model or cfg.get("model", ""),
            "prompt_tokens": u.get("prompt_tokens", u.get("input_tokens", 0)) or 0,
            "completion_tokens": u.get("completion_tokens", u.get("output_tokens", 0)) or 0,
        })
    except Exception:
        pass


def _utf8_safe(s: str) -> str:
    """Drop lone surrogates (e.g. '\\udc94' produced when Windows-1252/latin-1
    bytes reach us via surrogateescape in pasted text or stored asset context).
    They cannot be UTF-8 encoded, so httpx's JSON body serialization raises
    ('surrogates not allowed') and the whole LLM call fails. 'replace' on encode
    swaps each offending char for '?'; valid non-ASCII (中文/emoji) is untouched."""
    if not isinstance(s, str):
        return s
    return s.encode("utf-8", "replace").decode("utf-8")


def _chat(prompt: str, cfg: dict[str, str] | None = None, tool: str = "") -> str:
    """Call the configured LLM provider (cfg = routed tier config, default text config)."""
    cfg = cfg or _config
    prompt = _utf8_safe(prompt)
    try:
        import httpx
        provider = cfg["provider"]
        if provider == "vllm":
            # Discover model ID
            try:
                r = httpx.get(f"{cfg['endpoint']}/v1/models", timeout=5)
                models = r.json().get("data", [])
                model = models[0]["id"] if models else cfg["model"]
            except Exception:
                model = cfg["model"]
            resp = httpx.post(f"{cfg['endpoint']}/v1/chat/completions",
                json={"model": model, "messages": [{"role": "user", "content": prompt}],
                      "stop_token_ids": STOP_TOKEN_IDS, "temperature": 0}, timeout=30)
            resp.raise_for_status()
            data = resp.json()
            _record_usage(tool, cfg, data, model)
            return data["choices"][0]["message"]["content"]
        elif provider != "anthropic":
            # openai / deepseek / mimo / any OpenAI-compatible endpoint
            resp = httpx.post(f"{cfg['endpoint']}/chat/completions",
                headers={"Authorization": f"Bearer {cfg['api_key']}"},
                json={"model": cfg["model"], "messages": [{"role": "user", "content": prompt}]}, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            _record_usage(tool, cfg, data)
            return data["choices"][0]["message"]["content"]
        elif provider == "anthropic":
            resp = httpx.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={"model": cfg["model"], "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]}, timeout=120)
            resp.raise_for_status()
            data = resp.json()
            _record_usage(tool, cfg, data)
            for block in data.get("content", []):
                if block.get("type") == "text": return block["text"]
            return "(no text)"
        return f"(unreachable provider: {provider})"
    except Exception as e:
        return f"(LLM unavailable — {provider}: {e})"


def _vision(prompt: str, image_path: str, tool: str = "") -> str:
    """Multimodal call on the configured provider (local vLLM default, cloud optional)."""
    prompt = _utf8_safe(prompt)
    import httpx
    provider = _vision_config["provider"]
    if provider == "vllm":
        try:
            r = httpx.get(f"{_vision_config['endpoint']}/v1/models", timeout=5)
            models = r.json().get("data", [])
            model = models[0]["id"] if models else _vision_config["model"]
        except Exception:
            model = _vision_config["model"]
        resp = httpx.post(f"{_vision_config['endpoint']}/v1/chat/completions",
            json={"model": model,
                  "messages": [{"role": "user", "content": [
                      {"type": "text", "text": prompt},
                      {"type": "image_url", "image_url": {"url": _data_url(image_path)}}]}],
                  "stop_token_ids": STOP_TOKEN_IDS, "temperature": 0}, timeout=280)
        resp.raise_for_status()
        data = resp.json()
        _record_usage(tool, _vision_config, data, model)
        return data["choices"][0]["message"]["content"]
    elif provider != "anthropic":
        resp = httpx.post(f"{_vision_config['endpoint']}/chat/completions",
            headers={"Authorization": f"Bearer {_vision_config['api_key']}"},
            json={"model": _vision_config["model"],
                  "messages": [{"role": "user", "content": [
                      {"type": "text", "text": prompt},
                      {"type": "image_url", "image_url": {"url": _data_url(image_path)}}]}]},
            timeout=280)
        resp.raise_for_status()
        data = resp.json()
        _record_usage(tool, _vision_config, data)
        return data["choices"][0]["message"]["content"]
    elif provider == "anthropic":
        import base64
        import mimetypes
        mime = mimetypes.guess_type(image_path)[0] or "image/png"
        with open(image_path, "rb") as f:
            b64 = base64.b64encode(f.read()).decode("ascii")
        resp = httpx.post("https://api.anthropic.com/v1/messages",
            headers={"x-api-key": _vision_config["api_key"], "anthropic-version": "2023-06-01",
                     "content-type": "application/json"},
            json={"model": _vision_config["model"], "max_tokens": 4096,
                  "messages": [{"role": "user", "content": [
                      {"type": "image", "source": {"type": "base64", "media_type": mime, "data": b64}},
                      {"type": "text", "text": prompt}]}]},
            timeout=280)
        resp.raise_for_status()
        data = resp.json()
        _record_usage(tool, _vision_config, data)
        for block in data.get("content", []):
            if block.get("type") == "text":
                return block["text"]
        return "(no text)"
    raise ValueError(f"vision unsupported for provider: {provider}")


def _asset_context(message: str) -> str:
    """Search the asset store for context relevant to a chat message.
    Returns a compact context block ('' when nothing matches) — the flywheel's
    read side: answers cite committed assets instead of model memory."""
    try:
        hits = asset_store.search_assets(message, limit=3)
    except Exception:
        return ""
    blocks: list[str] = []
    for hit in hits:
        if hit.get("type") == "register-map":
            full = asset_store.get_asset(hit["id"])
            if not full:
                continue
            msg_tokens = {t.strip(",.?!:;()").upper() for t in message.split()}
            periph = next(
                (p["name"] for p in full.get("characterization", {}).get("peripherals", [])
                 if p["name"].upper() in msg_tokens), None)
            sl = svd_ingest.slice_regmap(full, peripheral=periph)
            blocks.append(f"[asset {hit['id']} register-map slice]\n" + json.dumps(sl)[:2048])
        elif hit.get("type"):
            blocks.append(
                f"[asset {hit['id']} {hit['type']}]\n" + json.dumps(hit.get("characterization", {}))[:1024])
        if len(blocks) >= 2:
            break
    if not blocks:
        return ""
    return ("Context from the devready asset store (authoritative, cite asset ids "
            "when you use them):\n" + "\n".join(blocks) + "\n---\n")

# ── MCP Tools ──
TOOLS = [
    {"name": "chat", "description": "Chat with the LLM (MiniCPM-V/OpenAI/Anthropic). Use for general questions, analysis, code generation.",
     "inputSchema": {"type": "object", "properties": {"message": {"type": "string", "description": "User message"}}, "required": ["message"]}},
    {"name": "characterize", "description": "Characterize a hardware device (e.g., HPM6E00 MCU). Returns chip info, peripherals, memory map, driver skeleton.",
     "inputSchema": {"type": "object", "properties": {"chip": {"type": "string", "description": "Chip name"}}, "required": ["chip"]}},
    {"name": "design_urdf", "description": "Design a URDF robot model from measurements/specs.",
     "inputSchema": {"type": "object", "properties": {"description": {"type": "string"}, "measurements": {"type": "object"}}, "required": ["description"]}},
    {"name": "identify_gap", "description": "Analyze sim2real gap between simulation and real measurements.",
     "inputSchema": {"type": "object", "properties": {"sim_result": {"type": "object"}, "real_result": {"type": "object"}}, "required": ["sim_result", "real_result"]}},
    {"name": "design_reward", "description": "Design a reward function for RL training.",
     "inputSchema": {"type": "object", "properties": {"task": {"type": "string"}, "robot": {"type": "string"}}, "required": ["task"]}},
    {"name": "decide_next_phase", "description": "Analyze pipeline results and decide which phase to go to next.",
     "inputSchema": {"type": "object", "properties": {"current_phase": {"type": "string"}, "results": {"type": "object"}}, "required": ["current_phase"]}},
    {"name": "set_api_config", "description": "Update the LLM provider configuration at runtime. preset=light|heavy|vision|text points the text channel at a named config (keys stay in the brain); reload=true restores everything from llm.json.",
     "inputSchema": {"type": "object", "properties": {"provider": {"type": "string"}, "endpoint": {"type": "string"}, "api_key": {"type": "string"}, "model": {"type": "string"}, "target": {"type": "string"}, "preset": {"type": "string"}, "reload": {"type": "boolean"}}}},
    {"name": "schematic_to_netlist", "description": "Analyze a schematic image (multimodal) and extract a structured netlist; commits it as a devready asset by default.",
     "inputSchema": {"type": "object", "properties": {
         "image_path": {"type": "string"},
         "commit": {"type": "boolean", "description": "Commit result as asset (default true)"},
         "hints": {"type": "string", "description": "Optional extraction hints"}},
      "required": ["image_path"]}},
    {"name": "ingest_svd", "description": "Ingest a CMSIS-SVD file into a register-map devready asset (deterministic, no LLM).",
     "inputSchema": {"type": "object", "properties": {
         "svd_path": {"type": "string"}, "chip": {"type": "string"}},
      "required": ["svd_path"]}},
    {"name": "query_regmap", "description": "Query register-map assets and return a prompt-sized peripheral slice (base address, registers, fields, reset values).",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "FTS query, e.g. 'STM32F103xx USART1'"},
         "peripheral": {"type": "string"}, "register": {"type": "string"}},
      "required": ["query"]}},
    {"name": "gen_test_plan", "description": "Generate a HIL test plan (flux.hil.plan/v1) from a natural-language goal. Asset-driven: probe addresses come from register-map assets, not model memory.",
     "inputSchema": {"type": "object", "properties": {
         "goal": {"type": "string"},
         "chip": {"type": "string", "description": "Chip to pull the register-map asset for (default STM32F103xx)"},
         "board": {"type": "string"}, "backend": {"type": "string", "enum": ["mock", "real", "sim"]},
         "use_assets": {"type": "boolean", "description": "false = bench 'bare' condition: no asset context, model memory only (default true)"},
         "pin_model": {"type": "boolean", "description": "true = skip tier routing, use the current text config exactly (bench)"}},
      "required": ["goal"]}},
    {"name": "compose_devready", "description": "Assemble the full DevReady asset (BODY/MIND/JOURNAL per FLUXmeme spec) for a board: pin map, memory map, boot modes, RTOS availability, build/flash howto, agent skills, linked lifetime records. Stable id per board (recompose overwrites) + content fingerprint; lands a .flux file.",
     "inputSchema": {"type": "object", "properties": {
         "board": {"type": "string", "description": "board id from skills/boards.json, e.g. hpm6e00evk"},
         "serial": {"type": "string", "description": "optional chip UID from a real probe, pins a physical instance"},
         "refresh_wiki": {"type": "boolean", "description": "refetch official docs into the pack (default: reuse embedded copies)"}},
      "required": ["board"]}},
    {"name": "add_board_lesson", "description": "Record a debugging lesson (symptom + fix) into the board's experience memory and re-embed it in the .flux DevReady asset immediately.",
     "inputSchema": {"type": "object", "properties": {
         "board": {"type": "string"}, "symptom": {"type": "string"}, "fix": {"type": "string"}},
      "required": ["board", "symptom"]}},
    {"name": "gen_board_skill", "description": "Generate an agent-skill pack (guide/setup/interview/build/troubleshoot SKILL.md) from a board's .flux DevReady asset. The troubleshoot skill learns from the board's accumulated fault history. Installable by Claude Code / Cursor / Codex.",
     "inputSchema": {"type": "object", "properties": {
         "board": {"type": "string", "description": "board id (must have a devready asset — run compose_devready first)"},
         "out_dir": {"type": "string", "description": "optional output dir (default ~/.flux/skills/<board>)"}},
      "required": ["board"]}},
    {"name": "scan_devices", "description": "Enumerate every plugged-in debug probe (USB), classify vendor/probe type, read serial + virtual UART, and flag which match a known board profile. First step of onboarding — 'is anything connected?'.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "identify_device", "description": "Classify one probe by USB vid:pid — vendor, probe type, silicon family, serial, UART, and whether we still need the user to name the exact chip.",
     "inputSchema": {"type": "object", "properties": {"vid": {"type": "string"}, "pid": {"type": "string"}}, "required": ["vid", "pid"]}},
    {"name": "onboard_device", "description": "Full new-board onboarding for ANY MCU: build/augment the board profile, fetch+ingest its SVD register map, run a comm sanity test, and stamp the probe serial into a DevReady asset. Pass a known board id, or a chip model + vid/pid from scan_devices.",
     "inputSchema": {"type": "object", "properties": {
         "board": {"type": "string", "description": "known board id (skips chip lookup)"},
         "chip": {"type": "string", "description": "exact chip model, e.g. STM32H743ZI (for a new/unknown board)"},
         "vid": {"type": "string"}, "pid": {"type": "string"},
         "serial": {"type": "string"}, "uart": {"type": "string"},
         "project_dir": {"type": "string", "description": "custom board: dir with .ioc/.NET design files (no vendor part needed)"}}}},
    {"name": "bind_chip", "description": "6th phase: stamp the DevReady record (magic + fingerprint + live chip UID) into the MCU's non-volatile Flash, read it back to verify persistence, and write the factory UID into the devready asset — binding asset↔silicon. Requires a real probe + openocd.",
     "inputSchema": {"type": "object", "properties": {
         "board": {"type": "string", "description": "board id (must have a devready asset)"},
         "dry_run": {"type": "boolean", "description": "read UID + report the plan without erasing/writing Flash"}},
      "required": ["board"]}},
    {"name": "verify_chip", "description": "Real-board verification without firmware: spawn openocd, read the debug IDCODE + factory UID to confirm the silicon is alive and matches the profile. What characterization needs (no firmware HIL).",
     "inputSchema": {"type": "object", "properties": {"board": {"type": "string"}}, "required": ["board"]}},
    {"name": "ingest_design", "description": "Extract a board's BSP from its DESIGN files (STM32CubeMX .ioc pin mux + Altium/Protel .NET netlist) for a CUSTOM board with no vendor SVD/pinmux. Produces a pin-map + schematic-knowledge asset and synthesizes a board profile. KiCad/EasyEDA on the roadmap.",
     "inputSchema": {"type": "object", "properties": {
         "project_dir": {"type": "string", "description": "path to the project dir containing .ioc / .NET files"},
         "board_id": {"type": "string", "description": "optional board id (default derived from MCU)"}},
      "required": ["project_dir"]}},
    {"name": "usage_stats", "description": "LLM token usage + routing-savings estimate (dashboard metering line). Aggregates the llm_usage table.",
     "inputSchema": {"type": "object", "properties": {
         "days": {"type": "number", "description": "Lookback window in days (default 7)"},
         "since_ts": {"type": "number", "description": "Epoch seconds; overrides days when set"}}}},
    {"name": "dream", "description": "Memory consolidation: merge triage cases into fault-knowledge, compute board-health from HIL reports, roll up old usage, mark duplicate assets superseded. Commits a dream-report. dry_run=true only reports what would happen.",
     "inputSchema": {"type": "object", "properties": {
         "dry_run": {"type": "boolean", "description": "Plan only, change nothing (default false)"}}}},
    {"name": "set_workspace", "description": "WorkSpace isolation: point the asset store (assets + usage, same DB) at <path>/.flux/assets.db. Empty/absent path switches back to the global store. API keys stay global.",
     "inputSchema": {"type": "object", "properties": {
         "path": {"type": "string", "description": "Project directory (empty = global)"}}}},
    {"name": "export_asset", "description": "Export devready assets to a portable JSON bundle (flux.assets/v1): one asset (asset_id), matching assets (query), or the whole store.",
     "inputSchema": {"type": "object", "properties": {
         "out_path": {"type": "string", "description": "Output file, e.g. ~/exports/hpm6e00.assets.json"},
         "asset_id": {"type": "string"}, "query": {"type": "string"},
         "limit": {"type": "integer"}},
      "required": ["out_path"]}},
    {"name": "delete_asset", "description": "Delete one devready asset by id from the current store (and its FTS index). Returns {deleted}.",
     "inputSchema": {"type": "object", "properties": {"asset_id": {"type": "string"}}, "required": ["asset_id"]}},
    {"name": "import_asset", "description": "Import a flux.assets/v1 bundle (or single envelope JSON) into the current store. overwrite=false skips existing asset_ids.",
     "inputSchema": {"type": "object", "properties": {
         "path": {"type": "string"}, "overwrite": {"type": "boolean"}},
      "required": ["path"]}},
    {"name": "ingest_pinmux", "description": "Boards without SVDs: parse the vendor pinmux.c into a pin-map asset (pad/function/group). pinmux_path optional when the board has a profile in skills/boards.json.",
     "inputSchema": {"type": "object", "properties": {
         "board": {"type": "string"}, "pinmux_path": {"type": "string"}},
      "required": ["board"]}},
    {"name": "list_skills", "description": "List FluxStudio-native skills (repo skills/*.md) and board profiles.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "get_skill", "description": "Read one studio skill's markdown by name (e.g. board-bringup).",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "guide_match", "description": "Classify a user's natural-language request into one of the studio's guided flows. Returns {flow_id|null}. flows = [{id, match}] passed by the UI (single source: guides.ts).",
     "inputSchema": {"type": "object", "properties": {
         "utterance": {"type": "string"},
         "flows": {"type": "array", "items": {"type": "object", "properties": {"id": {"type": "string"}, "match": {"type": "string"}}}}},
      "required": ["utterance", "flows"]}},
    {"name": "fw_generate_urdf", "description": "FluxWeave headless: assemble a URDF from a graph spec (parts + connectors with joint axes/points). Commits the result as a urdf asset.",
     "inputSchema": {"type": "object", "properties": {
         "graph": {"type": "object", "description": "{robot_name, base_link, parts:[{id,link_name,stl_file?,origin_xyz?,color_rgba?}], connectors:[{parent_id('__base__' for base),child_id,parent_axis,child_axis,parent_local_xyz,child_local_xyz,joint_type,joint_name,joint_limit_*,joint_effort,joint_velocity}]}"},
         "out_dir": {"type": "string", "description": "Optional: also export project (copies meshes, writes .urdf)"}},
      "required": ["graph"]}},
    {"name": "fw_read_metadata", "description": "FluxWeave: read the URDF-Kitchen metadata block embedded in an STL (link name, origin, connection points, color).",
     "inputSchema": {"type": "object", "properties": {"stl_path": {"type": "string"}}, "required": ["stl_path"]}},
    {"name": "ingest_datasheet", "description": "Extract register descriptions from a reference-manual PDF chapter into a register-map asset (confidence<1; SVD wins on conflict). Optional vision-LLM verification.",
     "inputSchema": {"type": "object", "properties": {
         "pdf_path": {"type": "string"}, "page_from": {"type": "integer"}, "page_to": {"type": "integer"},
         "chip": {"type": "string"}, "peripheral_hint": {"type": "string"},
         "verify_with_llm": {"type": "boolean"}},
      "required": ["pdf_path", "page_from", "page_to", "chip"]}},
    {"name": "ingest_dts", "description": "Ingest a flattened Zephyr devicetree (build/zephyr/zephyr.dts) into a devready asset. Runs automatically after every zephyr build.",
     "inputSchema": {"type": "object", "properties": {
         "dts_path": {"type": "string"}, "board": {"type": "string"}},
      "required": ["dts_path", "board"]}},
    {"name": "join_hwdesc", "description": "Cross-asset join: devicetree node (by label) reg address <-> register-map peripheral. dts says WHERE, SVD says WHAT.",
     "inputSchema": {"type": "object", "properties": {
         "dts_asset_id": {"type": "string"}, "chip": {"type": "string"}, "label": {"type": "string"}},
      "required": ["dts_asset_id", "chip", "label"]}},
    {"name": "generate_board_init", "description": "Generate peripheral init code. backend=register emits register-level C from a register-map asset (addresses/masks from the asset, not model memory); backend=zephyr_dts emits app.overlay + prj.conf.",
     "inputSchema": {"type": "object", "properties": {
         "chip": {"type": "string", "description": "register-map asset query"},
         "peripheral": {"type": "string"},
         "backend": {"type": "string", "enum": ["register", "zephyr_dts", "hpm_sdk"]},
         "config": {"type": "object"}},
      "required": ["chip", "peripheral"]}},
    {"name": "gen_sim_platform", "description": "Generate a Renode platform (.repl + reset-state .resc) from a register-map asset. The simulation is asset-derived, not hand-written.",
     "inputSchema": {"type": "object", "properties": {
         "chip": {"type": "string", "description": "register-map asset query, e.g. STM32F103xx"},
         "out_dir": {"type": "string"},
         "peripherals": {"type": "array", "items": {"type": "string"}}},
      "required": ["chip"]}},
    {"name": "triage", "description": "Sentinel-style fault triage: error log/text -> structured root-cause hypothesis with fix suggestions. Context comes from committed assets (register maps, past HIL reports); result is committed as a triage-case asset.",
     "inputSchema": {"type": "object", "properties": {
         "log": {"type": "string", "description": "Error text: build log, HIL failure, OpenOCD error, runtime fault"},
         "source": {"type": "string", "enum": ["build", "hil", "manual"]},
         "context": {"type": "object", "description": "Extra context, e.g. {board, chip, failed_step}"}},
      "required": ["log"]}},
    {"name": "commit_asset", "description": "Commit a devready asset (register-map, hil-report, netlist, ...) to the FTS asset store. Returns the asset_id.",
     "inputSchema": {"type": "object", "properties": {
         "asset_id": {"type": "string"}, "type": {"type": "string"},
         "source": {"type": "object"}, "components": {"type": "array", "items": {"type": "string"}},
         "characterization": {"type": "object"}, "health": {"type": "object"}},
      "required": ["type"]}},
    {"name": "query_asset", "description": "Query devready assets: FTS search (query), fetch one by id (asset_id), or list recent (neither).",
     "inputSchema": {"type": "object", "properties": {
         "query": {"type": "string", "description": "FTS query, e.g. 'register-map UART0'"},
         "asset_id": {"type": "string"}, "limit": {"type": "integer"}}}},
]

TRIAGE_CATEGORIES = ("compile_error", "link_error", "cmake_config", "toolchain",
                     "flash_error", "hardfault", "assertion_fail", "connection", "unknown")

# (regex, category) — deterministic fallback when the LLM is unavailable/invalid.
_TRIAGE_PATTERNS = [
    # compile errors first: they usually cause the trailing "ld returned 1" line
    (r"error: .*expected|error: .*undeclared|fatal error: .*No such file", "compile_error"),
    (r"undefined reference|ld returned|cannot find -l", "link_error"),
    (r"CMake Error", "cmake_config"),
    (r"command not found|toolchain|riscv32-|arm-none-eabi-.*not found", "toolchain"),
    (r"flash write|wrote .* error|Programming Failed|protected", "flash_error"),
    (r"HardFault|hard fault|Bus Fault|MemManage", "hardfault"),
    (r"assert|expected=.*actual=", "assertion_fail"),
    (r"Connection refused|timeout|no device found|libusb", "connection"),
]


def _triage_fallback(log: str, source: str) -> dict[str, Any]:
    import re
    category = "unknown"
    for pat, cat in _TRIAGE_PATTERNS:
        if re.search(pat, log, re.IGNORECASE):
            category = cat
            break
    first_err = next((ln for ln in log.splitlines() if "error" in ln.lower() or "fail" in ln.lower()), log[:200])
    return {
        "category": category, "root_cause": f"(heuristic) first failure line: {first_err.strip()[:200]}",
        "confidence": 0.2, "affected_files": [], "suggested_fixes": [],
        "raw_excerpt": first_err.strip()[:400], "source": source,
    }


def _triage(log: str, source: str, context: dict[str, Any]) -> dict[str, Any]:
    # Focused excerpt: error lines + tail, capped at 6KB — small-model reliability.
    lines = log.splitlines()
    err_lines = [ln for ln in lines if any(k in ln.lower() for k in ("error", "fail", "fault", "warning"))]
    excerpt = ("\n".join(err_lines[:40]) + "\n...\n" + "\n".join(lines[-30:]))[:6144]
    asset_ctx = _asset_context(" ".join([str(context.get("chip", "")), str(context.get("board", "")), excerpt[:400]]))
    prompt = (
        "You are a firmware fault-triage engineer (STM32/HPM6E00/Zephyr toolchains).\n"
        f"{asset_ctx}"
        f"Failure source: {source}. Context: {json.dumps(context)[:400]}\n"
        f"Error output:\n```\n{excerpt}\n```\n"
        "Return ONLY JSON: {\"category\": one of "
        f"{list(TRIAGE_CATEGORIES)}, "
        "\"root_cause\": one-sentence hypothesis, \"confidence\": 0..1, "
        "\"affected_files\": [{\"path\",\"line\",\"reason\"}], "
        "\"suggested_fixes\": [{\"title\",\"detail\"}], \"raw_excerpt\": the key error line}"
    )
    raw = _chat(prompt, _route("triage", prompt), tool="triage")
    try:
        result = _extract_json(raw)
        if result.get("category") not in TRIAGE_CATEGORIES:
            result["category"] = "unknown"
        result.setdefault("confidence", 0.5)
        result["source"] = source
        return result
    except (ValueError, AttributeError):
        return _triage_fallback(log, source)


def handle_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Execute a tool and return MCP result."""
    if name == "chat":
        message = args["message"]
        # use_assets=False = bench "bare" condition: model answers from memory alone.
        ctx = _asset_context(message) if args.get("use_assets", True) else ""
        full = ctx + message
        reply = _chat(full, _route("chat", full), tool="chat")
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "characterize":
        chip = args.get("chip", "HPM6E00")
        prompt = f"Characterize the {chip} MCU concisely. Return JSON with chip, core, peripherals[], memory_map{{}}, driver_skeleton{{}}."
        reply = _chat(prompt, _route(name, prompt), tool=name)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "design_urdf":
        desc = args["description"]
        prompt = f"Design a URDF robot model for: {desc}. Return the URDF XML."
        reply = _chat(prompt, _route(name, prompt), tool=name)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "identify_gap":
        sim = json.dumps(args["sim_result"])
        real = json.dumps(args["real_result"])
        prompt = f"Analyze the sim2real gap. Sim: {sim}. Real: {real}. What parameters need adjustment?"
        reply = _chat(prompt, _route(name, prompt), tool=name)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "design_reward":
        task = args["task"]
        robot = args.get("robot", "quadruped")
        prompt = f"Design a reward function for {robot} to {task}. List reward components with weights."
        reply = _chat(prompt, _route(name, prompt), tool=name)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "decide_next_phase":
        phase = args["current_phase"]
        results = json.dumps(args.get("results", {}))
        prompt = f"Pipeline phase '{phase}' completed. Results: {results}. Which phase next? (asset_construct, asset_calibrate, policy_design, deploy, done)"
        reply = _chat(prompt, _route(name, prompt), tool=name)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "set_api_config":
        # reload=true: restore everything from llm.json (bench runner cleanup).
        if args.get("reload"):
            _load_llm_json()
            return {"content": [{"type": "text", "text": json.dumps(
                {"reloaded": True, "provider": _config["provider"], "model": _config["model"]})}]}
        # preset: point the TEXT channel at a named tier/channel config — the
        # bench switches models this way so API keys never leave the brain.
        preset = args.get("preset")
        if preset:
            src = {"text": _config, "vision": _vision_config, **_tiers}.get(str(preset))
            if src is None:
                raise RuntimeError(f"unknown preset: {preset} (have text/vision/{'/'.join(_tiers)})")
            for k in ("provider", "endpoint", "api_key", "model"):
                _config[k] = src[k]
            log.info(f"API config preset -> {preset}: {_config['provider']} {_config['model']}")
            return {"content": [{"type": "text", "text": json.dumps(
                {"preset": preset, "provider": _config["provider"], "model": _config["model"]})}]}
        target = _vision_config if args.get("target") == "vision" else _config
        # The renderer sends camelCase `apiKey`; the brain config uses `api_key`.
        # Without this alias the key silently never applies (cloud API unusable).
        if "apiKey" in args and "api_key" not in args:
            args = {**args, "api_key": args["apiKey"]}
        for k, v in args.items():
            # empty strings must not clobber keys loaded from llm.json
            if k in target and k != "target" and str(v) != "":
                target[k] = str(v)
        log.info(f"API config updated ({args.get('target', 'text')}): {target['provider']} {target['model']}")
        _save_llm_json()  # persist so the key survives a restart (machine-local)
        return {"content": [{"type": "text", "text": json.dumps(
            {"target": args.get("target", "text"), "provider": target["provider"], "model": target["model"]})}]}
    elif name == "schematic_to_netlist":
        path = args["image_path"]
        prompt = SCHEMATIC_PROMPT + (f"\nHints: {args['hints']}" if args.get("hints") else "")
        raw = _vision(prompt, path, tool="schematic_to_netlist")
        try:
            netlist = _extract_json(raw)
        except ValueError:
            return {"content": [{"type": "text", "text": json.dumps({"raw": raw, "parse_error": True})}]}
        out: dict[str, Any] = {"netlist": netlist}
        if args.get("commit", True):
            import hashlib
            sha = hashlib.sha256(open(path, "rb").read()).hexdigest()
            components = [c.get("ref", c.get("id", "?")) if isinstance(c, dict) else str(c)
                          for c in netlist.get("components", [])][:32]
            out["asset_id"] = asset_store.commit_asset({
                "asset_id": f"netlist-{sha[:8]}",
                "type": "schematic-netlist",
                "source": {"kind": "schematic-image", "path": path, "sha256": sha,
                           "provider": _vision_config["provider"], "model": _vision_config["model"]},
                "components": components,
                "characterization": {"netlist": netlist},
            })
            out["type"] = "schematic-netlist"
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "gen_test_plan":
        goal = args["goal"]
        chip = args.get("chip", "STM32F103xx")
        board = args.get("board", "stm32f103-bluepill")
        backend = args.get("backend", "mock")
        use_assets = args.get("use_assets", True)
        # Flywheel read side: probe addresses MUST come from the register-map asset.
        # use_assets=False = bench "bare" condition — the with/without score delta
        # is the asset store's pricing anchor.
        gpio_slice = svd_ingest.query_regmap(chip, peripheral="GPIOC") if use_assets else {}
        asset_id = gpio_slice.get("asset_id", "")
        few_shot = json.dumps({
            "schema": "flux.hil.plan/v1", "name": "gpio-smoke",
            "goal": "verify firmware toggles the LED",
            "target": {"backend": backend, "board": board, "chip": chip},
            "source_assets": [asset_id],
            "steps": [
                {"id": "flash", "type": "flash", "deps": [], "params": {"elf": "firmware/blinky.elf"}},
                {"id": "p1", "type": "probe", "deps": ["flash"], "params": {"op": "read_mem", "addr": "0x4001100C"}},
                {"id": "w1", "type": "wait", "deps": ["p1"], "params": {"ms": 200}},
                {"id": "p2", "type": "probe", "deps": ["w1"], "params": {"op": "read_mem", "addr": "0x4001100C"}},
                {"id": "toggle", "type": "assert", "deps": ["p1", "p2"],
                 "params": {"expr": {"lhs": "$p1.value", "op": "ne", "rhs": "$p2.value"},
                            "message": "GPIO output toggles"}}]})
        asset_block = (
            f"AUTHORITATIVE register map slice from asset store (use these addresses ONLY, "
            f"cite the asset id in source_assets):\n{json.dumps(gpio_slice)[:2400]}\n"
            if use_assets else
            "No asset context available — derive register addresses from your own knowledge.\n"
        )
        prompt = (
            "You write hardware-in-the-loop test plans as flux.hil.plan/v1 JSON.\n"
            "Step types: flash|reset|probe|assert|wait. probe params: {op:read_mem,addr}|{op:read_reg,reg}. "
            "assert params.expr: {lhs:'$stepId.value', op:eq|ne|lt|gt|in_range|mask_eq|matches, rhs, mask?}. "
            "Every step has id and deps[].\n"
            f"{asset_block}"
            f"Example plan:\n{few_shot}\n"
            f"Target: backend={backend}, board={board}, chip={chip}.\n"
            f"Goal: {goal}\n"
            "Output ONLY the JSON plan, no prose."
        )
        # pin_model=true (bench runner): score the CURRENT text config exactly —
        # tier routing would silently shunt every bench call to the heavy model.
        cfg = _config if args.get("pin_model") else _route("gen_test_plan", prompt)
        raw = _chat(prompt, cfg, tool="gen_test_plan")
        try:
            plan = _extract_json(raw)
            if plan.get("schema") != "flux.hil.plan/v1" or not plan.get("steps"):
                raise ValueError("missing schema/steps")
            plan.setdefault("source_assets", [asset_id] if asset_id else [])
            return {"content": [{"type": "text", "text": json.dumps(plan, ensure_ascii=False)}]}
        except ValueError as e:
            raise RuntimeError(f"gen_test_plan: LLM did not return a valid plan ({e})") from e
    elif name == "ingest_svd":
        summary = svd_ingest.commit_svd(args["svd_path"], args.get("chip"))
        log.info(f"asset committed: {summary['asset_id']} (register-map, {summary['registers']} regs)")
        return {"content": [{"type": "text", "text": json.dumps(summary, ensure_ascii=False)}]}
    elif name == "query_regmap":
        sl = svd_ingest.query_regmap(args["query"], args.get("peripheral"), args.get("register"))
        return {"content": [{"type": "text", "text": json.dumps(sl, ensure_ascii=False)}]}
    elif name == "fw_generate_urdf":
        import hashlib
        from flux_brain import fluxweave_core  # lazy: needs numpy + vendored stl_metadata
        graph = fluxweave_core.GraphSpec.from_dict(args["graph"])
        if args.get("out_dir"):
            result = fluxweave_core.export_urdf_project(graph, args["out_dir"])
            urdf_text = open(result["urdf_path"]).read()
        else:
            urdf_text = fluxweave_core.generate_urdf(graph)
            result = {"urdf_path": None, "meshes_copied": 0}
        sha = hashlib.sha256(urdf_text.encode()).hexdigest()
        aid = asset_store.commit_asset({
            "asset_id": f"urdf-{graph.robot_name}-{sha[:8]}",
            "type": "urdf",
            "source": {"kind": "fluxweave-graph", "robot": graph.robot_name},
            "components": [graph.robot_name, *(p.link_name for p in graph.parts)],
            "characterization": {"urdf": urdf_text, "links": len(graph.parts) + 1,
                                 "joints": len(graph.connectors), **result},
        })
        log.info(f"asset committed: {aid} (urdf, {len(graph.connectors)} joints)")
        return {"content": [{"type": "text", "text": json.dumps(
            {"asset_id": aid, "type": "urdf", **result, "urdf": urdf_text[:1000]}, ensure_ascii=False)}]}
    elif name == "fw_read_metadata":
        from flux_brain import fluxweave_core  # lazy: needs numpy + vendored stl_metadata
        xml_text = fluxweave_core.read_metadata(args["stl_path"])
        if xml_text is None:
            return {"content": [{"type": "text", "text": json.dumps({"error": "no embedded metadata"})}]}
        return {"content": [{"type": "text", "text": json.dumps(
            fluxweave_core.parse_metadata_xml(xml_text), ensure_ascii=False)}]}
    elif name == "ingest_datasheet":
        summary = pdf_ingest.commit_datasheet(
            args["pdf_path"], int(args["page_from"]), int(args["page_to"]),
            args["chip"], args.get("peripheral_hint"), bool(args.get("verify_with_llm", False)))
        log.info(f"asset committed: {summary['asset_id']} (datasheet regmap, {summary['registers']} regs)")
        return {"content": [{"type": "text", "text": json.dumps(summary, ensure_ascii=False)}]}
    elif name == "ingest_dts":
        summary = dts_ingest.commit_dts(args["dts_path"], args["board"])
        log.info(f"asset committed: {summary['asset_id']} (devicetree, {summary['nodes']} nodes)")
        return {"content": [{"type": "text", "text": json.dumps(summary, ensure_ascii=False)}]}
    elif name == "join_hwdesc":
        j = dts_ingest.join_regmap(args["dts_asset_id"], args["chip"], args["label"])
        return {"content": [{"type": "text", "text": json.dumps(j, ensure_ascii=False)}]}
    elif name == "generate_board_init":
        sl = svd_ingest.query_regmap(args["chip"], peripheral=args["peripheral"])
        if "error" in sl:
            raise RuntimeError(sl["error"])
        backend = args.get("backend", "register")
        out = codegen.gen_from_regmap(sl, backend=backend, config=args.get("config", {}))
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "gen_sim_platform":
        out_dir = args.get("out_dir") or os.path.join(
            os.path.expanduser(os.environ.get("FLUX_HOME", "~/.flux")), "sim")
        summary = repl_gen.build_sim_platform(args["chip"], out_dir, args.get("peripherals"))
        log.info(f"sim platform generated: {summary['repl']}")
        return {"content": [{"type": "text", "text": json.dumps(summary, ensure_ascii=False)}]}
    elif name == "triage":
        import time
        source = args.get("source", "manual")
        result = _triage(args["log"], source, args.get("context", {}))
        # Flywheel write-back: every triage becomes a searchable fault case.
        case_id = asset_store.commit_asset({
            "asset_id": f"triage-{source}-{int(time.time())}",
            "type": "triage-case",
            "source": {"kind": "triage", "origin": source},
            "components": [str(args.get("context", {}).get("chip", "")),
                           str(args.get("context", {}).get("board", "")), result["category"]],
            "characterization": result,
        })
        result["asset_id"] = case_id
        log.info(f"triage: {result['category']} conf={result.get('confidence')} -> {case_id}")
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]}
    elif name == "commit_asset":
        asset_id = asset_store.commit_asset(args)
        log.info(f"asset committed: {asset_id} ({args.get('type', '?')})")
        return {"content": [{"type": "text", "text": json.dumps({"asset_id": asset_id})}]}
    elif name == "query_asset":
        if args.get("asset_id"):
            found = asset_store.get_asset(args["asset_id"])
            payload = found if found is not None else {"error": f"not found: {args['asset_id']}"}
        elif args.get("query"):
            payload = asset_store.search_assets(args["query"], limit=int(args.get("limit", 5)))
        else:
            payload = asset_store.list_assets(limit=int(args.get("limit", 100)))
        return {"content": [{"type": "text", "text": json.dumps(payload, ensure_ascii=False)}]}
    elif name == "compose_devready":
        boards_json = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json")
        out = devready.compose_devready(args["board"], os.path.normpath(boards_json), serial=args.get("serial"),
                                        refresh_wiki=bool(args.get("refresh_wiki", False)))
        if "error" not in out:
            log.info(f"devready composed: {out['asset_id']} pins={out['body_pins']} rtos={out['rtos_available']}")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "add_board_lesson":
        boards_json = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json"))
        out = devready.add_board_lesson(args["board"], args.get("symptom", ""), args.get("fix", ""), boards_json)
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "gen_board_skill":
        out = board_skillgen.generate_board_skills(args["board"], args.get("out_dir"))
        if "error" not in out:
            log.info(f"board skills: {out['board']} -> {len(out['skills'])} skills in {out['skill_dir']}")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "scan_devices":
        bj = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json")
        return {"content": [{"type": "text", "text": json.dumps(onboard.scan(os.path.normpath(bj)), ensure_ascii=False)}]}
    elif name == "identify_device":
        bj = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json")
        return {"content": [{"type": "text", "text": json.dumps(onboard.identify(args["vid"], args["pid"], os.path.normpath(bj)), ensure_ascii=False)}]}
    elif name == "onboard_device":
        bj = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json"))
        out = onboard.onboard(bj, chip=args.get("chip"), board=args.get("board"),
                              vid=args.get("vid"), pid=args.get("pid"),
                              serial=args.get("serial", ""), uart=args.get("uart"),
                              project_dir=args.get("project_dir"))
        if "error" not in out:
            log.info(f"onboarded {out['board']} ({out['chip']}) serial={out['serial'][:12]} -> {out['devready_asset']}")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "verify_chip":
        bj = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json"))
        out = chip_bind.verify_chip_live(args["board"], bj)
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "bind_chip":
        bj = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json"))
        out = chip_bind.bind_chip(args["board"], bj, dry_run=bool(args.get("dry_run", False)))
        if out.get("verified"):
            log.info(f"bound {out['board']}: uid={out['uid']} fp={out['fingerprint']} @ {out['slot']}")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "ingest_design":
        bj = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "skills", "boards.json"))
        out = pcb_ingest.ingest_design(args["project_dir"], bj, args.get("board_id"))
        if "error" not in out:
            log.info(f"pcb ingest: {out['board']} ({out['mcu']}) {out['pin_count']} pins, devices={out.get('board_devices')}")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "usage_stats":
        stats = asset_store.usage_stats(
            days=float(args.get("days", 7)),
            since_ts=float(args["since_ts"]) if args.get("since_ts") is not None else None)
        return {"content": [{"type": "text", "text": json.dumps(stats, ensure_ascii=False)}]}
    elif name == "dream":
        from flux_brain import dream as dream_mod
        # Consolidation always rides the light tier — never the heavy model.
        light = _tiers.get("light", _config)
        result = dream_mod.consolidate(
            dry_run=bool(args.get("dry_run", False)),
            summarize=lambda p: _chat(p, light, tool="dream"))
        log.info(f"dream: cats={len(result['merged_categories'])} boards={len(result['boards'])} "
                 f"superseded={len(result['superseded'])} dry_run={result['dry_run']}")
        return {"content": [{"type": "text", "text": json.dumps(result, ensure_ascii=False)}]}
    elif name == "set_workspace":
        info = asset_store.set_workspace(args.get("path") or None)
        log.info(f"workspace -> {info['workspace']} ({info['asset_count']} assets)")
        return {"content": [{"type": "text", "text": json.dumps(info, ensure_ascii=False)}]}
    elif name == "export_asset":
        out = asset_store.export_assets(
            args["out_path"], asset_id=args.get("asset_id"),
            query=args.get("query"), limit=int(args.get("limit", 500)))
        log.info(f"exported {out['count']} assets -> {out['path']}")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "delete_asset":
        deleted = asset_store.delete_asset(args["asset_id"])
        return {"content": [{"type": "text", "text": json.dumps({"deleted": deleted, "asset_id": args["asset_id"]})}]}
    elif name == "import_asset":
        out = asset_store.import_assets(args["path"], overwrite=bool(args.get("overwrite", True)))
        log.info(f"imported {out['imported']} assets (skipped {out['skipped']})")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "ingest_pinmux":
        board = args["board"]
        path = args.get("pinmux_path")
        if not path:
            prof = pinmux_ingest.board_profile(board)
            path = (prof or {}).get("pinmux")
            if not path:
                raise RuntimeError(f"no pinmux_path given and no profile for board: {board}")
        out = pinmux_ingest.commit_pinmux(path, board)
        if "error" not in out:
            log.info(f"asset committed: {out['asset_id']} (pinmap, {out['pin_count']} pins)")
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "list_skills":
        return {"content": [{"type": "text", "text": json.dumps({
            "skills": pinmux_ingest.list_skills(),
            "boards": [{"id": b.get("id"), "name": b.get("name"), "chip": b.get("chip")}
                        for b in pinmux_ingest.load_boards()],
        }, ensure_ascii=False)}]}
    elif name == "get_skill":
        text = pinmux_ingest.get_skill(args["name"])
        if text is None:
            return {"content": [{"type": "text", "text": json.dumps({"error": f"skill not found: {args['name']}"})}]}
        return {"content": [{"type": "text", "text": text}]}
    elif name == "guide_match":
        flows = args.get("flows", [])
        ids = [str(f.get("id", "")) for f in flows if f.get("id")]
        catalog = "\n".join(f"- {f.get('id')}: {f.get('match', '')}" for f in flows)
        prompt = (
            "You route a user's request to ONE guided UI flow, or none.\n"
            f"Flows:\n{catalog}\n\n"
            f'User said: "{args.get("utterance", "")}"\n'
            "Pick the single best matching flow id, or null if the user is just asking a "
            "question / none fits. Reply ONLY JSON: {\"flow_id\": \"<id>\" or null}."
        )
        raw = _chat(prompt, _tiers.get("light", _config), tool="guide_match")
        try:
            res = _extract_json(raw)
            fid = res.get("flow_id")
            if fid not in ids:
                fid = None
        except (ValueError, AttributeError):
            fid = None
        log.info(f"guide_match: {args.get('utterance', '')[:40]!r} -> {fid}")
        return {"content": [{"type": "text", "text": json.dumps({"flow_id": fid}, ensure_ascii=False)}]}
    return {"content": [{"type": "text", "text": f"(unknown tool: {name})"}]}


# ── MCP JSON-RPC over stdio ──
def main():
    log.info("Flux-Insight MCP server starting")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue

        method = msg.get("method", "")
        msg_id = msg.get("id")

        if method == "initialize":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": {
                "protocolVersion": "2025-11-25",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "flux-insight", "version": "0.3.0"}}}
        elif method == "notifications/initialized":
            continue  # notification, no response
        elif method == "tools/list":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
        elif method == "tools/call":
            tool_name = msg["params"]["name"]
            tool_args = msg["params"].get("arguments", {})
            try:
                result = handle_tool(tool_name, tool_args)
                response = {"jsonrpc": "2.0", "id": msg_id, "result": result}
            except Exception as e:
                response = {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(e)}}
        else:
            response = {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"unknown method: {method}"}}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
