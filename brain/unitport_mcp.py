#!/usr/bin/env python3
"""UnitPort MCP server — canvas→spec compilation + registries (Qt-free chain).

Runs under vendor/integrations/.venv-unitport (python 3.11, UnitPort deps).
Training execution itself is NOT here: the kernel's TrainingAgent spawns the
sb3_entry subprocess directly and owns its lifecycle (scheduling, events,
cancel). This server exposes the synchronous, cheap calls.
"""
import json
import logging
import os
import sys
from pathlib import Path

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
log = logging.getLogger("unitport")

UP_ROOT = Path(__file__).resolve().parents[1] / "vendor" / "integrations" / "UnitPort"
sys.path.insert(0, str(UP_ROOT / "src"))
os.chdir(UP_ROOT)

TOOLS = [
    {"name": "up.list_templates", "description": "List bundled UnitPort canvas templates (ready-to-train robot setups).",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "up.get_template", "description": "Load one canvas template JSON by name.",
     "inputSchema": {"type": "object", "properties": {"name": {"type": "string"}}, "required": ["name"]}},
    {"name": "up.compile_spec", "description": "Compile a canvas dict into a TrainingSpec (validation issues included). The spec feeds the kernel TrainingAgent.",
     "inputSchema": {"type": "object", "properties": {"canvas": {"type": "object"}}, "required": ["canvas"]}},
]


def _templates_dir() -> Path:
    return UP_ROOT / "custom_mods" / "canvas"


def handle_tool(name: str, args: dict) -> dict:
    if name == "up.list_templates":
        out = []
        for p in sorted(_templates_dir().rglob("*.json")):
            out.append({"name": p.stem, "backend": p.parent.name, "path": str(p)})
        return {"content": [{"type": "text", "text": json.dumps(out, ensure_ascii=False)}]}
    elif name == "up.get_template":
        want = args["name"]
        for p in _templates_dir().rglob("*.json"):
            if p.stem == want:
                return {"content": [{"type": "text", "text": p.read_text()}]}
        return {"content": [{"type": "text", "text": json.dumps({"error": f"template not found: {want}"})}]}
    elif name == "up.compile_spec":
        from application.compiler.lowering import canvas_to_ir  # noqa: PLC0415
        from application.training.spec_compiler import compile_training_spec  # noqa: PLC0415

        ir = canvas_to_ir(args["canvas"])
        spec, issues = compile_training_spec(ir)
        return {"content": [{"type": "text", "text": json.dumps({
            "spec": spec.to_dict() if hasattr(spec, "to_dict") else spec,
            "issues": [str(i) for i in issues] if issues else [],
        }, ensure_ascii=False, default=str)}]}
    return {"content": [{"type": "text", "text": f"(unknown tool: {name})"}]}


def main() -> None:
    log.info("UnitPort MCP server starting")
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            continue
        method, msg_id = msg.get("method", ""), msg.get("id")
        if method == "initialize":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": {
                "protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                "serverInfo": {"name": "unitport", "version": "0.1.0"}}}
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
        elif method == "tools/call":
            try:
                result = handle_tool(msg["params"]["name"], msg["params"].get("arguments", {}))
                response = {"jsonrpc": "2.0", "id": msg_id, "result": result}
            except Exception as e:  # noqa: BLE001
                response = {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(e)}}
        else:
            response = {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"unknown method: {method}"}}
        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
