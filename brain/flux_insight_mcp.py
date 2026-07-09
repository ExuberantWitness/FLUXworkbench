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

# ── Multi-provider LLM ──
_config = {
    "provider": os.environ.get("FLUX_LLM_PROVIDER", "vllm"),
    "endpoint": os.environ.get("FLUX_LLM_ENDPOINT", "http://127.0.0.1:8000"),
    "api_key": os.environ.get("FLUX_LLM_API_KEY", ""),
    "model": os.environ.get("FLUX_LLM_MODEL", "openbmb/MiniCPM-V-4.6"),
}

STOP_TOKEN_IDS = [248044, 248046]

def _chat(prompt: str) -> str:
    """Call the configured LLM provider."""
    try:
        import httpx
        provider = _config["provider"]
        if provider == "vllm":
            # Discover model ID
            try:
                r = httpx.get(f"{_config['endpoint']}/v1/models", timeout=5)
                models = r.json().get("data", [])
                model = models[0]["id"] if models else _config["model"]
            except Exception:
                model = _config["model"]
            resp = httpx.post(f"{_config['endpoint']}/v1/chat/completions",
                json={"model": model, "messages": [{"role": "user", "content": prompt}],
                      "stop_token_ids": STOP_TOKEN_IDS, "temperature": 0}, timeout=30)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        elif provider == "openai":
            resp = httpx.post(f"{_config['endpoint']}/chat/completions",
                headers={"Authorization": f"Bearer {_config['api_key']}"},
                json={"model": _config["model"], "messages": [{"role": "user", "content": prompt}]}, timeout=30)
            resp.raise_for_status()
            return resp.json()["choices"][0]["message"]["content"]
        elif provider == "anthropic":
            resp = httpx.post("https://api.anthropic.com/v1/messages",
                headers={"x-api-key": _config["api_key"], "anthropic-version": "2023-06-01", "content-type": "application/json"},
                json={"model": _config["model"], "max_tokens": 1024, "messages": [{"role": "user", "content": prompt}]}, timeout=30)
            resp.raise_for_status()
            for block in resp.json().get("content", []):
                if block.get("type") == "text": return block["text"]
            return "(no text)"
        return f"(unknown provider: {provider})"
    except Exception as e:
        return f"(LLM unavailable — {provider}: {e})"

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
    {"name": "schematic_to_netlist", "description": "Analyze a schematic image and extract netlist/components.",
     "inputSchema": {"type": "object", "properties": {"image_path": {"type": "string"}}, "required": ["image_path"]}},
]

def handle_tool(name: str, args: dict[str, Any]) -> dict[str, Any]:
    """Execute a tool and return MCP result."""
    if name == "chat":
        reply = _chat(args["message"])
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "characterize":
        chip = args.get("chip", "HPM6E00")
        prompt = f"Characterize the {chip} MCU concisely. Return JSON with chip, core, peripherals[], memory_map{{}}, driver_skeleton{{}}."
        reply = _chat(prompt)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "design_urdf":
        desc = args["description"]
        prompt = f"Design a URDF robot model for: {desc}. Return the URDF XML."
        reply = _chat(prompt)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "identify_gap":
        sim = json.dumps(args["sim_result"])
        real = json.dumps(args["real_result"])
        prompt = f"Analyze the sim2real gap. Sim: {sim}. Real: {real}. What parameters need adjustment?"
        reply = _chat(prompt)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "design_reward":
        task = args["task"]
        robot = args.get("robot", "quadruped")
        prompt = f"Design a reward function for {robot} to {task}. List reward components with weights."
        reply = _chat(prompt)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "decide_next_phase":
        phase = args["current_phase"]
        results = json.dumps(args.get("results", {}))
        prompt = f"Pipeline phase '{phase}' completed. Results: {results}. Which phase next? (asset_construct, asset_calibrate, policy_design, deploy, done)"
        reply = _chat(prompt)
        return {"content": [{"type": "text", "text": reply}]}
    elif name == "set_api_config":
        for k, v in args.items():
            if k in _config:
                _config[k] = str(v)
        log.info(f"API config updated: {_config['provider']} {_config['model']}")
        return {"content": [{"type": "text", "text": f"Provider set to {_config['provider']}"}]}
    elif name == "schematic_to_netlist":
        path = args["image_path"]
        prompt = f"Analyze schematic at {path}. Return netlist JSON."
        reply = _chat(prompt)
        return {"content": [{"type": "text", "text": reply}]}
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
