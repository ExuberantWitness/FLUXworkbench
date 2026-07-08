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


def _mock_characterize(_session: object | None = None) -> dict[str, Any]:
    """Offline characterization fallback (no LLM). Returns canned HPM6E00 data."""
    return {
        "chip": "HPM6E0",
        "core": "RISC-V RV32 (dual-core)",
        "peripherals": ["GPIO", "UART", "SPI", "I2C", "CAN", "PWM", "ADC"],
        "memory_map": {"flash": "0x80000000", "ram": "0x00000000", "size": "8MB"},
        "driver_skeleton": {
            "language": "c",
            "init": "hpm6e_gpio_init(pin, mode);",
            "notes": "baseline skeleton; real driver generated with LLM characterize",
        },
        "bench": {"method": "gpio-toggle", "status": "stub"},
    }


def _vllm_characterize() -> dict[str, Any]:
    """Use local MiniCPM-V 4.6 (vLLM :8000) to characterize HPM6E00.

    Replaces the mock-agent with real local LLM reasoning. Asks the model for
    chip/peripheral/memory-map/driver info in JSON. Falls back to mock on any error.
    """
    import json as _json
    import httpx

    resp = httpx.get("http://127.0.0.1:8000/v1/models", timeout=5)
    model = resp.json()["data"][0]["id"]
    prompt = (
        "You are a hardware engineer. Characterize the HPM6E00 MCU concisely.\n"
        "Return STRICT JSON only (no prose, no markdown) with this schema:\n"
        '{"chip":"HPM6E0","core":"...","peripherals":["GPIO","UART",...],'
        '"memory_map":{"flash":"0x...","ram":"0x...","size":"..."},'
        '"driver_skeleton":{"language":"c","init":"...","notes":"..."},'
        '"bench":{"method":"gpio-toggle","status":"stub"}}\n'
        "Return ONLY the JSON object."
    )
    r = httpx.post(
        "http://127.0.0.1:8000/v1/chat/completions",
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stop_token_ids": [248044, 248046],
            "temperature": 0,
        },
        timeout=30,
    )
    r.raise_for_status()
    raw = r.json()["choices"][0]["message"]["content"].strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    return _json.loads(raw)


def _characterize() -> dict[str, Any]:
    """Try local MiniCPM-V 4.6; fall back to mock if vLLM unavailable."""
    try:
        return _vllm_characterize()
    except Exception:
        log.warning("vLLM unavailable, using mock characterize")
        return _mock_characterize()


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

    # Live memory-page trail: one Session per boot, appending a chunk per uORB event.
    # On a successful flash/halt the brain forks a branch and commits a devready
    # asset bundle carrying the branch's lineage (provenance / 谱系). Real
    # characterization + Anthropic agent arrive in build-task #4.
    from flux_brain.session import create_session, event_chunk, user_text_chunk
    from flux_brain.workflow import board_bringup_workflow

    session = create_session(
        user_text_chunk("Flux Workbench boot — HPM6E00 bring-up"),
        operator="boot",
    )

    # Python produces the flow (decision #20): publish the board-bringup DAG so the
    # TS kernel can dispatch it (and the renderer can render it). TS dispatch is the
    # next build-task; for now the boot-smoke still pokes cmd.flash directly.
    wf = board_bringup_workflow()
    bus.publish({
        "source": "brain", "kind": "propose", "topic": "workflow.published",
        "data": wf.to_dict(), "trace_id": "boot",
    })

    def on_openocd(evt: dict[str, Any]) -> None:
        nonlocal session
        session = session.append(
            event_chunk(evt.get("topic", "openocd.event"),
                        evt.get("source", "openocd"), evt.get("data"))
        )
        d = evt.get("data", {}) or {}
        reply = str(d.get("reply", ""))
        # commit a devready asset only on a successful flash (the real bring-up
        # milestone); halt is just a probe step.
        if d.get("cmd") == "cmd.flash" and "OK" in reply:
            # characterize via local MiniCPM-V 4.6 (vLLM :8000); mock fallback.
            characterization = _characterize()
            bus.publish({
                "source": "brain", "kind": "attribute", "topic": "agent.event",
                "data": {"step": "characterize", **characterization},
                "trace_id": evt.get("trace_id", ""),
            })
            log.info("agent characterized: %s", characterization["chip"])

            branch = session.fork(operator="devready-commit")
            bus.publish({
                "source": "brain", "kind": "execute", "topic": "asset.committed",
                "data": {
                    "asset_id": "hpm6e00-bringup-001",
                    "components": ["device-profile", "driver", "bench"],
                    "trigger": d.get("cmd"),
                    "characterization": characterization,
                    "session": {
                        "id": branch.id,
                        "chunks": len(branch.chunk_table),
                        "lineage": branch.lineage.to_dict(),
                    },
                },
                "trace_id": evt.get("trace_id", ""),
            })
            log.info("devready commit: %s", branch.brief())

    bus.subscribe("openocd.event", on_openocd)
    bus.publish({"source": "brain", "kind": "log", "topic": "brain.ready",
                 "data": {}, "trace_id": ""})
    bus.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())
