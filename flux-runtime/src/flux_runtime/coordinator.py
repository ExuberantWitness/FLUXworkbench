"""Coordinator — multi-task multi-thread scheduler over Subagents.

The one scheduler that owns the runtime's concurrency:

    asyncio            cooperative I/O   (CAN/serial/sim network streams)
    ThreadPoolExecutor blocking I/O      (pyserial, OpenOCD CLI, camera frames)
    ProcessPoolExecutor CPU-bound        (Newton / FLUXVortex / FluxPhased)

All Subagent kinds are scheduled uniformly through ``dispatch`` / ``gather``;
device vs solver vs cloud is a capability difference, not a scheduling one.
"""
from __future__ import annotations

import asyncio
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from typing import Any, Callable

from .primitives import Event, Loop, Message, Subagent


class Coordinator:
    def __init__(self, threads: int = 8, processes: int | None = None):
        self._subs: dict[str, Subagent] = {}
        self._threads = ThreadPoolExecutor(max_workers=threads, thread_name_prefix="flux-io")
        self._procs = (
            ProcessPoolExecutor(max_workers=processes) if processes else None
        )

    # ── registration ────────────────────────────────────────────────
    def register(self, sa: Subagent) -> Subagent:
        self._subs[sa.id] = sa
        return sa

    def get(self, sa_id: str) -> Subagent:
        return self._subs[sa_id]

    # ── multi-task dispatch ─────────────────────────────────────────
    async def dispatch(self, msg: Message) -> list[Event]:
        """Send a Message to its target Subagent; collect the Event trace."""
        sa = self._subs[msg.target]
        return [e async for e in sa.step(msg)]

    async def gather(self, messages: list[Message]) -> list[list[Event]]:
        """Multi-task: dispatch N messages concurrently, return all traces."""
        return await asyncio.gather(*(self.dispatch(m) for m in messages))

    # ── multi-thread / multi-process offload ────────────────────────
    async def run_threaded(self, fn: Callable[..., Any], *args, **kw) -> Any:
        """Run a blocking callable on the I/O thread pool."""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._threads, lambda: fn(*args, **kw))

    async def run_process(self, fn: Callable[..., Any], *args, **kw) -> Any:
        """Run a CPU-bound callable on the solver process pool."""
        if self._procs is None:
            raise RuntimeError("no process pool configured")
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._procs, lambda: fn(*args, **kw))

    # ── loop driver ─────────────────────────────────────────────────
    async def drive(self, loop: Loop, goal: str):
        """Run a Loop, feeding it ``dispatch`` as the Subagent API."""
        async for ev in loop.run(goal, self.dispatch):
            yield ev

    # ── lifecycle ───────────────────────────────────────────────────
    async def shutdown(self) -> None:
        for sa in list(self._subs.values()):
            await sa.stop()
        self._threads.shutdown(wait=False, cancel_futures=True)
        if self._procs:
            self._procs.shutdown(wait=False, cancel_futures=True)
