"""uORB-over-stdio bridge (Python side) — connects the supervised Python brain
to the TS kernel over newline-JSON frames (ADR 0002 hybrid bus).

Symmetric wire protocol (one JSON object per line)::

    {"t":"pub",  "topic":.., "source":.., "kind":.., "data":{..}, "trace_id":..}   # publish Event
    {"t":"sub",  "topic":..}                                                       # subscribe to topic
    {"t":"unsub","topic":..}
    {"t":"cmd",  "target":.., "op":.., "args":[..], "kwargs":{..}, "trace_id":..}  # command Message

v1: forward-all pubs + record remote subs. Topic filtering tightened later.
Run as a module entrypoint: ``python -m flux_brain.bus_ipc``.
"""
from __future__ import annotations

import json
import logging
import sys
import threading
from typing import Any, Callable, TextIO

log = logging.getLogger("flux_brain.bus_ipc")

Frame = dict[str, Any]
Handler = Callable[[dict[str, Any]], None]


class IpcBus:
    """Bidirectional uORB bridge over stdio. The Python brain uses this in place of
    a Zenoh session when talking to the local TS kernel (its parent process)."""

    def __init__(self, stdin: TextIO = sys.stdin, stdout: TextIO = sys.stdout) -> None:
        self._stdin = stdin
        self._stdout = stdout
        self._lock = threading.Lock()
        self._subs: set[str] = set()            # topics the remote (TS) wants from us
        self._handlers: dict[str, list[Handler]] = {}

    # ── write frames to remote ────────────────────────────────────────────────
    def _write(self, frame: Frame) -> None:
        with self._lock:
            self._stdout.write(json.dumps(frame, ensure_ascii=False) + "\n")
            self._stdout.flush()

    # ── local API (the brain calls these) ─────────────────────────────────────
    def subscribe(self, topic: str, handler: Handler) -> None:
        self._handlers.setdefault(topic, []).append(handler)
        self._write({"t": "sub", "topic": topic})

    def unsubscribe(self, topic: str) -> None:
        self._handlers.pop(topic, None)
        self._write({"t": "unsub", "topic": topic})

    def publish(self, event: dict[str, Any]) -> None:
        # event: {source, kind, topic, data, trace_id}
        self._write({"t": "pub", **event})

    def send_cmd(self, target: str, op: str, *, args: list | None = None,
                 kwargs: dict | None = None, trace_id: str = "") -> None:
        self._write({"t": "cmd", "target": target, "op": op,
                     "args": args or [], "kwargs": kwargs or {}, "trace_id": trace_id})

    # ── read loop (blocks; run on main thread or a dedicated one) ──────────────
    def run(self) -> None:
        for line in self._stdin:
            line = line.strip()
            if not line:
                continue
            try:
                f = json.loads(line)
            except json.JSONDecodeError:
                log.warning("bad frame: %r", line[:80])
                continue
            self._dispatch(f)

    def _dispatch(self, f: Frame) -> None:
        t = f.get("t")
        if t == "pub":
            evt = {k: f.get(k) for k in ("source", "kind", "topic", "data", "trace_id")}
            for h in self._handlers.get(evt.get("topic", ""), []):
                try:
                    h(evt)
                except Exception:  # noqa: BLE001
                    log.exception("handler error on topic %s", evt.get("topic"))
        elif t == "sub":
            self._subs.add(f.get("topic", ""))
        elif t == "unsub":
            self._subs.discard(f.get("topic", ""))
        elif t == "cmd":
            log.info("cmd from kernel: target=%s op=%s", f.get("target"), f.get("op"))


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s",
                        stream=sys.stderr)
    bus = IpcBus()
    log.info("flux-brain IPC bridge ready (stdio)")
    # Demo wiring for smoke test: subscribe to cmd.flash, announce ready.
    def on_cmd_flash(_evt: dict[str, Any]) -> None: ...  # real handler wired in build-task #4
    bus.subscribe("cmd.flash", on_cmd_flash)
    bus.publish({"source": "brain", "kind": "log", "topic": "brain.ready",
                 "data": {}, "trace_id": ""})
    bus.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
