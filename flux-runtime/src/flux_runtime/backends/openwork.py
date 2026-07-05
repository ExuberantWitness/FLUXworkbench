"""openwork as a Subagent — the agent-cowork engine plugged into the Flux shell.

Flux runtime is the host; openwork (OpenCode agent) is a backend. The Flux
Loop delegates general agent work (coding, tool-use, MCP) here via
``agent_run``. openwork's own Electron UI is not used — only its
orchestrator + server (driven headless).

Capabilities:
    agent_run(prompt)   run the OpenCode agent on a task
    agent_status()      orchestrator/server health

Spawn is real (`openwork start --workspace <ws> --approval auto --no-tui` via
the orchestrator bin). HTTP dispatch against openwork-server is best-effort —
the server's request surface mirrors @opencode-ai/sdk (sessions/messages/SSE);
confirm exact routes + the server port against a live orchestrator first.
openwork needs Node (Bun optional) + its opencode sidecar resolved.
"""
from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.request
from pathlib import Path
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


class OpenWorkSubagent(Subagent):
    capabilities = ("agent_run", "agent_status")

    def __init__(
        self,
        id: str,
        *,
        openwork_root: str,
        workspace: str,
        server_port: int = 8431,
        runner: str = "node",
    ) -> None:
        self.id = id
        self.openwork_root = openwork_root
        self.workspace = workspace
        self.server_port = server_port
        self.runner = runner
        self._proc: asyncio.subprocess.Process | None = None

    @property
    def _base(self) -> str:
        return f"http://127.0.0.1:{self.server_port}"

    async def start(self) -> None:
        bin_openwork = Path(self.openwork_root) / "apps" / "orchestrator" / "bin" / "openwork"
        self._proc = await asyncio.create_subprocess_exec(
            self.runner, str(bin_openwork),
            "start",
            "--workspace", self.workspace,
            "--approval", "auto",
            "--no-tui",
            cwd=self.openwork_root,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        # Best-effort wait for the server port (port is uncertain — verify on first run).
        for _ in range(60):
            r = await asyncio.to_thread(_http, "GET", f"{self._base}/health")
            if not (isinstance(r, dict) and r.get("_error")):
                return
            await asyncio.sleep(0.5)

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
            if op == "agent_status":
                out = await asyncio.to_thread(_http, "GET", f"{self._base}/health")
            elif op == "agent_run":
                prompt = msg.args[0] if msg.args else ""
                # Two-step best-effort: create a session, then send the prompt.
                sess = await asyncio.to_thread(
                    _http, "POST", f"{self._base}/sessions", {"workspace": self.workspace},
                )
                sid = sess.get("id") if isinstance(sess, dict) else None
                out = await asyncio.to_thread(
                    _http, "POST", f"{self._base}/sessions/{sid}/messages", {"content": prompt},
                ) if sid else sess
            else:
                yield Event(self.id, "error", {"op": op, "err": "unknown op"}, msg.trace_id)
                return
            yield Event(self.id, op, {"result": out}, msg.trace_id)
        except Exception as e:  # never crash the loop
            yield Event(self.id, "error", {"op": op, "err": repr(e)}, msg.trace_id)
