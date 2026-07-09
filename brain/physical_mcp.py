#!/usr/bin/env python3
"""Physical-subagent MCP server — OpenOCD measurement/flash/deploy tools.

Exposes hardware interaction tools as MCP:
- openocd.read_reg / openocd.read_mem — measure hardware
- openocd.flash — flash firmware
- openocd.halt / openocd.reset — control target
- physical.observe — observe real hardware behavior
"""
import json
import sys
import os
import subprocess
import logging

logging.basicConfig(level=logging.INFO, format="%(message)s", stream=sys.stderr)
log = logging.getLogger("physical")

OPENOCD_BIN = os.environ.get("FLUX_OPENOCD_BIN", "/tmp/hpm-openocd/src/openocd")
OPENOCD_CFG = os.environ.get("FLUX_OPENOCD_CFG", "/home/exuber/hpm_sdk/boards/openocd/hpm6e00_all_in_one.cfg")
HPM_SDK_BASE = os.environ.get("HPM_SDK_BASE", "/home/exuber/hpm_sdk")
REAL_MODE = os.environ.get("FLUX_OPENOCD_REAL", "0") == "1"

# ── OpenOCD TCL RPC client ──
_openocd_proc = None

def _ensure_openocd():
    global _openocd_proc
    if _openocd_proc and _openocd_proc.poll() is None:
        return
    if not REAL_MODE:
        # Mock mode
        return
    env = {**os.environ, "HPM_SDK_BASE": HPM_SDK_BASE, "OPENOCD_SCRIPTS": f"{HPM_SDK_BASE}/boards/openocd"}
    _openocd_proc = subprocess.Popen(
        [OPENOCD_BIN, "-c", f"set HPM_SDK_BASE {HPM_SDK_BASE}", "-f", OPENOCD_CFG, "-c", "init; halt"],
        stderr=subprocess.PIPE, stdout=subprocess.PIPE, env=env)
    import time; time.sleep(5)  # wait for init

def _openocd_cmd(cmd: str) -> str:
    if not REAL_MODE:
        return f"mock:{cmd}"
    # Connect to OpenOCD TCL port (6666) and send command
    import socket
    _ensure_openocd()
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.connect(("127.0.0.1", 6666))
    s.send((cmd + "\x1a").encode())
    data = b""
    while True:
        chunk = s.recv(4096)
        if not chunk: break
        data += chunk
        if b"\x1a" in data: break
    s.close()
    return data.replace(b"\x1a", b"").decode().strip()

TOOLS = [
    {"name": "openocd.read_reg", "description": "Read a hardware register via OpenOCD.",
     "inputSchema": {"type": "object", "properties": {"reg": {"type": "string", "description": "Register name or address"}}, "required": ["reg"]}},
    {"name": "openocd.read_mem", "description": "Read memory via OpenOCD.",
     "inputSchema": {"type": "object", "properties": {"addr": {"type": "string"}, "count": {"type": "integer", "default": 1}}, "required": ["addr"]}},
    {"name": "openocd.flash", "description": "Flash firmware to the target board.",
     "inputSchema": {"type": "object", "properties": {"elf_path": {"type": "string"}}, "required": ["elf_path"]}},
    {"name": "openocd.halt", "description": "Halt the target CPU.",
     "inputSchema": {"type": "object", "properties": {}}},
    {"name": "openocd.reset", "description": "Reset the target board.",
     "inputSchema": {"type": "object", "properties": {"run": {"type": "boolean", "default": True}}}},
    {"name": "openocd.measure", "description": "Measure board response (read vendor ID, clock, peripherals).",
     "inputSchema": {"type": "object", "properties": {"metric": {"type": "string", "description": "What to measure"}}}},
]

def handle_tool(name: str, args: dict) -> dict:
    if name == "openocd.read_reg":
        result = _openocd_cmd(f"reg {args['reg']}")
        return {"content": [{"type": "text", "text": result}]}
    elif name == "openocd.read_mem":
        addr = args["addr"]
        count = args.get("count", 1)
        result = _openocd_cmd(f"mdw {addr} {count}")
        return {"content": [{"type": "text", "text": result}]}
    elif name == "openocd.flash":
        elf = args["elf_path"]
        result = _openocd_cmd(f"flash write_image erase {elf}")
        return {"content": [{"type": "text", "text": result}]}
    elif name == "openocd.halt":
        result = _openocd_cmd("halt")
        return {"content": [{"type": "text", "text": result or "halted"}]}
    elif name == "openocd.reset":
        run = args.get("run", True)
        result = _openocd_cmd(f"reset {'run' if run else 'halt'}")
        return {"content": [{"type": "text", "text": result or "reset done"}]}
    elif name == "openocd.measure":
        metric = args.get("metric", "vendor_id")
        if metric == "vendor_id":
            result = _openocd_cmd("reg mvendorid")
        else:
            result = _openocd_cmd(f"mdw 0x{metric} 1")
        return {"content": [{"type": "text", "text": f"{metric}: {result}"}]}
    return {"content": [{"type": "text", "text": f"(unknown: {name})"}]}


def main():
    log.info(f"Physical-subagent MCP server starting (mode={'REAL' if REAL_MODE else 'MOCK'})")
    for line in sys.stdin:
        line = line.strip()
        if not line: continue
        try: msg = json.loads(line)
        except: continue

        method = msg.get("method", "")
        msg_id = msg.get("id")

        if method == "initialize":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": {
                "protocolVersion": "2025-11-25", "capabilities": {"tools": {}},
                "serverInfo": {"name": "physical-subagent", "version": "0.3.0"}}}
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            response = {"jsonrpc": "2.0", "id": msg_id, "result": {"tools": TOOLS}}
        elif method == "tools/call":
            try:
                result = handle_tool(msg["params"]["name"], msg["params"].get("arguments", {}))
                response = {"jsonrpc": "2.0", "id": msg_id, "result": result}
            except Exception as e:
                response = {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32603, "message": str(e)}}
        else:
            response = {"jsonrpc": "2.0", "id": msg_id, "error": {"code": -32601, "message": f"unknown: {method}"}}

        sys.stdout.write(json.dumps(response) + "\n")
        sys.stdout.flush()

if __name__ == "__main__":
    main()
