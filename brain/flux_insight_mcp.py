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
from flux_brain import asset_store, codegen, dts_ingest, fluxweave_core, pdf_ingest, repl_gen, svd_ingest  # noqa: E402
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
}
_vision_config = dict(_config)
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
        _tiers[tier] = {**_config, **{k: str(v) for k, v in cfg.items()}}
    log.info(f"llm.json loaded: text={_config['provider']}/{_config['model']} "
             f"vision={_vision_config['provider']}/{_vision_config['model']} "
             f"tiers={[f'{t}:{c['model']}' for t, c in _tiers.items()]}")


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

def _chat(prompt: str, cfg: dict[str, str] | None = None) -> str:
    """Call the configured LLM provider (cfg = routed tier config, default text config)."""
    cfg = cfg or _config
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
            return resp.json()["choices"][0]["message"]["content"]
        elif provider != "anthropic":
            # openai / deepseek / mimo / any OpenAI-compatible endpoint
            resp = httpx.post(f"{cfg['endpoint']}/chat/completions",
                headers={"Authorization": f"Bearer {cfg['api_key']}"},
                json={"model": cfg["model"], "messages": [{"role": "user", "content": prompt}]}, timeout=120)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        elif provider == "anthropic":
            resp = httpx.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": cfg["api_key"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={"model": cfg["model"], "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]}, timeout=120)
            resp.raise_for_status()
            for block in resp.json().get("content", []):
                if block.get("type") == "text": return block["text"]
            return "(no text)"
        return f"(unreachable provider: {provider})"
    except Exception as e:
        return f"(LLM unavailable — {provider}: {e})"


def _vision(prompt: str, image_path: str) -> str:
    """Multimodal call on the configured provider (local vLLM default, cloud optional)."""
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
        return resp.json()["choices"][0]["message"]["content"]
    elif provider != "anthropic":
        resp = httpx.post(f"{_vision_config['endpoint']}/chat/completions",
            headers={"Authorization": f"Bearer {_vision_config['api_key']}"},
            json={"model": _vision_config["model"],
                  "messages": [{"role": "user", "content": [
                      {"type": "text", "text": prompt},
                      {"type": "image_url", "image_url": {"url": _data_url(image_path)}}]}]},
            timeout=280)
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]
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
        for block in resp.json().get("content", []):
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
    {"name": "set_api_config", "description": "Update the LLM provider configuration at runtime.",
     "inputSchema": {"type": "object", "properties": {"provider": {"type": "string"}, "endpoint": {"type": "string"}, "api_key": {"type": "string"}, "model": {"type": "string"}}}},
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
         "board": {"type": "string"}, "backend": {"type": "string", "enum": ["mock", "real", "sim"]}},
      "required": ["goal"]}},
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
    raw = _chat(prompt, _route("triage", prompt))
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
        full = _asset_context(message) + message
        reply = _chat(full, _route("chat", full))
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "characterize":
        chip = args.get("chip", "HPM6E00")
        prompt = f"Characterize the {chip} MCU concisely. Return JSON with chip, core, peripherals[], memory_map{{}}, driver_skeleton{{}}."
        reply = _chat(prompt, _route(name, prompt))
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "design_urdf":
        desc = args["description"]
        prompt = f"Design a URDF robot model for: {desc}. Return the URDF XML."
        reply = _chat(prompt, _route(name, prompt))
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "identify_gap":
        sim = json.dumps(args["sim_result"])
        real = json.dumps(args["real_result"])
        prompt = f"Analyze the sim2real gap. Sim: {sim}. Real: {real}. What parameters need adjustment?"
        reply = _chat(prompt, _route(name, prompt))
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "design_reward":
        task = args["task"]
        robot = args.get("robot", "quadruped")
        prompt = f"Design a reward function for {robot} to {task}. List reward components with weights."
        reply = _chat(prompt, _route(name, prompt))
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "decide_next_phase":
        phase = args["current_phase"]
        results = json.dumps(args.get("results", {}))
        prompt = f"Pipeline phase '{phase}' completed. Results: {results}. Which phase next? (asset_construct, asset_calibrate, policy_design, deploy, done)"
        reply = _chat(prompt, _route(name, prompt))
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "set_api_config":
        target = _vision_config if args.get("target") == "vision" else _config
        for k, v in args.items():
            # empty strings must not clobber keys loaded from llm.json
            if k in target and k != "target" and str(v) != "":
                target[k] = str(v)
        log.info(f"API config updated ({args.get('target', 'text')}): {target['provider']} {target['model']}")
        return {"content": [{"type": "text", "text": f"{args.get('target', 'text')} provider set to {target['provider']}"}]}
    elif name == "schematic_to_netlist":
        path = args["image_path"]
        prompt = SCHEMATIC_PROMPT + (f"\nHints: {args['hints']}" if args.get("hints") else "")
        raw = _vision(prompt, path)
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
        # Flywheel read side: probe addresses MUST come from the register-map asset.
        gpio_slice = svd_ingest.query_regmap(chip, peripheral="GPIOC")
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
        prompt = (
            "You write hardware-in-the-loop test plans as flux.hil.plan/v1 JSON.\n"
            "Step types: flash|reset|probe|assert|wait. probe params: {op:read_mem,addr}|{op:read_reg,reg}. "
            "assert params.expr: {lhs:'$stepId.value', op:eq|ne|lt|gt|in_range|mask_eq|matches, rhs, mask?}. "
            "Every step has id and deps[].\n"
            f"AUTHORITATIVE register map slice from asset store (use these addresses ONLY, "
            f"cite the asset id in source_assets):\n{json.dumps(gpio_slice)[:2400]}\n"
            f"Example plan:\n{few_shot}\n"
            f"Target: backend={backend}, board={board}, chip={chip}.\n"
            f"Goal: {goal}\n"
            "Output ONLY the JSON plan, no prose."
        )
        raw = _chat(prompt, _route("gen_test_plan", prompt))
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
