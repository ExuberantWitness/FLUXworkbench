"""Flux-Insight as a Subagent — the research brain of the Loop.

Wraps `run_dashboard.py` (Starlette Dashboard on :8420) + the Claim-Chain
(`cc.db`). The Flux runtime Loop calls this for the ``research`` phase of
``research -> write -> execute -> debug``; every action is grounded in the
accumulated Claim Chain.

Capabilities:
    research(goal)        init + drive a PES pipeline; returns a plan/hypotheses
    query_claims(query)   semantic search over cc.db
    ingest(text)          feed text -> cc.db atoms (via FLUXturbo construct)
    status()              dashboard health

Spawn is real. HTTP dispatch is best-effort against the documented Dashboard
REST surface (`/api/pipeline/{init,execute,state}`, `/api/sessions/...`,
`/api/sessions/<id>/claim-chain`) — confirm exact shapes against a live
Flux-Insight before relying on them.
"""
from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from typing import AsyncIterator

from ..primitives import Event, Message, Subagent


def _http(method: str, url: str, body: dict | None = None, timeout: float = 15.0):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        url, data=data, method=method,
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode()
            return json.loads(raw) if raw else None
    except (urllib.error.URLError, urllib.error.HTTPError, json.JSONDecodeError) as e:
        return {"_error": repr(e)}


class FluxInsightSubagent(Subagent):
    capabilities = ("research", "query_claims", "ingest", "status")

    def __init__(
        self,
        id: str,
        *,
        fi_root: str,
        python_exe: str,
        workspace: str,
        port: int = 8420,
    ) -> None:
        self.id = id
        self.fi_root = fi_root
        self.python_exe = python_exe
        self.workspace = workspace
        self.port = port
        self._proc: asyncio.subprocess.Process | None = None

    @property
    def _base(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    async def start(self) -> None:
        # Dashboard mode (Python, no bash skills); API embedding (not the unix-socket BGE).
        env = dict(os.environ)
        env["EMBEDDING_PROVIDER"] = env.get("EMBEDDING_PROVIDER", "api")
        self._proc = await asyncio.create_subprocess_exec(
            self.python_exe, "run_dashboard.py",
            cwd=self.fi_root,
            env=env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        # Wait for the dashboard port.
        for _ in range(60):
            r = await asyncio.to_thread(_http, "GET", f"{self._base}/api/sessions")
            if not (isinstance(r, dict) and r.get("_error")):
                return
            await asyncio.sleep(0.5)
        # else: still returned; the engine may be starting — step() will report errors.

    async def stop(self) -> None:
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
        self._proc = None

    async def step(self, msg: Message) -> AsyncIterator[Event]:
        op = msg.op
        try:
            if op == "status":
                out = await asyncio.to_thread(_http, "GET", f"{self._base}/api/sessions")
            elif op == "research":
                goal = msg.args[0] if msg.args else ""
                init = await asyncio.to_thread(
                    _http, "POST", f"{self._base}/api/pipeline/init",
                    {"goal": goal, "workspace": self.workspace},
                )
                out = await asyncio.to_thread(
                    _http, "POST", f"{self._base}/api/pipeline/execute",
                    {"workspace": self.workspace},
                ) if not _errored(init) else init
            elif op == "query_claims":
                q = msg.args[0] if msg.args else ""
                out = await asyncio.to_thread(
                    _http, "GET", f"{self._base}/api/sessions/all/claim-chain?q={urllib.parse.quote(q)}",
                )
            elif op == "ingest":
                text = msg.args[0] if msg.args else ""
                out = await asyncio.to_thread(
                    _http, "POST", f"{self._base}/api/sessions/all/claim-chain/ingest", {"text": text},
                )
            else:
                yield Event(self.id, "error", {"op": op, "err": "unknown op"}, msg.trace_id)
                return
            yield Event(self.id, op, {"result": out}, msg.trace_id)
        except Exception as e:  # never crash the loop
            yield Event(self.id, "error", {"op": op, "err": repr(e)}, msg.trace_id)


def _errored(r) -> bool:
    return isinstance(r, dict) and "_error" in r


# urllib.parse used in step() — import here to keep top-level light.
import urllib.parse  # noqa: E402
