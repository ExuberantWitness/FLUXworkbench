#!/usr/bin/env python3
"""CI smoke test — prove the packaged AI backend actually starts.

Runs the flux-insight MCP server under the EMBEDDED python (the one baked by
fetch-python.mjs, with brain/requirements.txt), drives the MCP handshake, and
asserts tools/list contains `chat`. This runs natively on the windows / macOS /
linux release runners, so it catches the exact class of bug where flux-insight
crashed at startup in the packaged app (missing numpy, unbundled vendor, …) and
only `openocd.*` tools survived — before we ever publish an installer.

Usage:  <embedded_python> scripts/smoke_flux_insight.py [<embedded_python>]
The optional arg is the interpreter used to spawn the server (defaults to the
one running this script).
"""
import json
import os
import subprocess
import sys

PY = sys.argv[1] if len(sys.argv) > 1 else sys.executable
SCRIPT = os.path.join("brain", "flux_insight_mcp.py")

handshake = [
    {"jsonrpc": "2.0", "id": 1, "method": "initialize",
     "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                "clientInfo": {"name": "smoke", "version": "1"}}},
    {"jsonrpc": "2.0", "method": "notifications/initialized"},
    {"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}},
]
stdin = "".join(json.dumps(m) + "\n" for m in handshake)

print(f"smoke: spawning {PY} {SCRIPT}")
proc = subprocess.run([PY, SCRIPT], input=stdin, capture_output=True,
                      text=True, timeout=90)

tools = []
for line in proc.stdout.splitlines():
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    if msg.get("id") == 2 and "result" in msg:
        tools = [t["name"] for t in msg["result"].get("tools", [])]

# `chat` is the core LLM tool 小Flux calls; require it plus a healthy count so a
# partial registration can't pass.
if "chat" not in tools or len(tools) < 30:
    sys.stderr.write(
        "SMOKE FAIL: flux-insight did not start cleanly.\n"
        f"  tools listed ({len(tools)}): {tools[:12]}\n"
        f"  server stderr (tail):\n{proc.stderr[-3000:]}\n")
    sys.exit(1)

print(f"SMOKE OK: flux-insight up with {len(tools)} tools including chat")
