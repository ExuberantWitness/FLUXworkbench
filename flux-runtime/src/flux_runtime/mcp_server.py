"""Flux Workbench MCP server — exposes the runtime's four pillars as MCP tools.

Registered in .mcp.json so Claude Code's agent can directly:
  flux_list_subagents()     → see connected devices + capabilities
  flux_dispatch(...)        → execute on hardware (measure → attribute → asset)
  flux_list_assets()        → browse .flux DevReady (BODY/MIND/JOURNAL)
  flux_sim(...)             → NVIDIA Warp predict-before-act
  flux_claims(...)          → query Flux-Insight Claim-Chain (research grounding)

The runtime server (http://127.0.0.1:8430) must be running; this MCP server
is a thin stdio client that wraps its REST API. Run via:
  python -m flux_runtime.mcp_server
"""
from __future__ import annotations

import json
import os
import urllib.parse
import urllib.request

BASE = os.environ.get("FLUX_RUNTIME_URL", "http://127.0.0.1:8430")


def _get(path: str, **params) -> dict | list:
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BASE}{path}?{qs}" if qs else f"{BASE}{path}"
    with urllib.request.urlopen(url, timeout=30) as r:
        return json.loads(r.read().decode())


def _post(path: str, **params) -> dict | list:
    qs = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    url = f"{BASE}{path}?{qs}"
    req = urllib.request.Request(url, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def main() -> None:
    from mcp.server.fastmcp import FastMCP

    mcp = FastMCP("flux-workbench")

    @mcp.tool()
    def flux_list_subagents() -> list:
        """List all registered hardware subagents and their capabilities.
        Returns device id, kind, target, gdb_port, and available ops."""
        return _get("/api/subagents")

    @mcp.tool()
    def flux_dispatch(target: str, op: str, args: str = "") -> list:
        """Dispatch an operation to a hardware subagent (execute half).
        Measurements are automatically stored as .flux DevReady assets.
        Examples: flux_dispatch("hpm-0","read_register","mvendorid")
                  flux_dispatch("hpm-0","read_mem","0x400064C0,1")
                  flux_dispatch("stm32-0","read_idcode","")"""
        return _post("/api/dispatch", target=target, op=op, args=args)

    @mcp.tool()
    def flux_list_assets() -> dict:
        """List .flux DevReady assets — BODY (device topology), MIND (driver/skills),
        JOURNAL (measurements). Each dispatch creates BODY + JOURNAL records."""
        return _get("/api/assets")

    @mcp.tool()
    def flux_sim(torque_mnm: float = 50.0, steps: int = 2000) -> dict:
        """Run NVIDIA Warp mechanical simulation (World pillar).
        Real rigid-rotor dynamics: J·dω/dt = τ − b·ω.
        Predict-before-act: given a torque, returns RPM trajectory.
        GPU-ready (RTX 2060 detected)."""
        return _post("/api/sim", torque_mnm=torque_mnm, steps=steps)

    @mcp.tool()
    def flux_claims(query: str = "", limit: int = 20) -> dict:
        """Query the Flux-Insight Claim-Chain (research half).
        Returns accumulated claims (atoms) from cc.db — the grounding knowledge
        for hardware development decisions. Search by keyword."""
        return _get("/api/claims", q=query, limit=limit)

    @mcp.tool()
    def flux_export(fmt: str = "usd") -> str:
        """Export .flux assets to a standard format.
        fmt: 'usd' (BODY→USDA scene), 'mcap' (JOURNAL→rosbag), 'okf' (MIND→markdown).
        Returns the exported file path."""
        import tempfile
        ext = {"usd": "usda", "mcap": "mcap", "okf": "md"}.get(fmt, "bin")
        out = os.path.join(tempfile.gettempdir(), f"flux-export.{ext}")
        url = f"{BASE}/api/assets/export?fmt={fmt}"
        with urllib.request.urlopen(url, timeout=30) as r:
            with open(out, "wb") as f:
                f.write(r.read())
        return out

    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
