"""Hardware-free mock subagents — for offline dev / UI demo / tests.

MockOpenOCDSubagent returns canned register/memory values grounded in
guideline.md (HPM mvendorid 0x0000031e, IDCODE 0x1000563d, FDCAN TXBC
0x030000dc). Same interface as OpenOCDSubagent, so the UI/coordinator can't
tell the difference — swap in the real one when a board is attached.
"""
from __future__ import annotations

import asyncio
from typing import AsyncIterator

from .primitives import Event, Message, Subagent

_HPM_REGS = {
    "mvendorid": "0x0000031e",   # Andes (guideline §5.1)
    "marchid": "0x80000045",
    "mimpid": "0x00001420",
    "mhartid": "0x00000000",
    "misa": "0x4094112d",
}
_HPM_MEM = {
    0x400064C0: "0x030000dc",   # STM32 FDCAN TXBC (guideline §12)
    0xF3158160: "0xf514a05a",   # HPM OTP UUID word 0 (guideline §5.2)
}


class MockOpenOCDSubagent(Subagent):
    capabilities = (
        "connect", "disconnect", "halt", "resume",
        "read_register", "read_mem", "write_mem", "read_idcode", "flash",
    )

    def __init__(self, id: str, target: str = "hpm", gdb_port: int = 3333) -> None:
        self.id = id
        self.target = target
        self.gdb_port = gdb_port

    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def step(self, msg: Message) -> AsyncIterator[Event]:
        await asyncio.sleep(0.05)  # simulate JTAG round-trip latency
        op = msg.op
        if op == "read_register":
            name = msg.args[0] if msg.args else "mvendorid"
            yield Event(self.id, op, {"name": name, "value": _HPM_REGS.get(name, "0xdeadbeef")}, msg.trace_id)
        elif op == "read_mem":
            addr = msg.args[0] if msg.args else 0x400064C0
            yield Event(self.id, op, {"addr": hex(addr), "value": _HPM_MEM.get(addr, "0x00000000")}, msg.trace_id)
        elif op == "read_idcode":
            yield Event(self.id, op, {"idcode": "0x1000563d", "mfg": "Andes 0x31e"}, msg.trace_id)
        elif op in ("halt", "resume", "connect", "disconnect", "write_mem"):
            yield Event(self.id, op, {"status": "ok"}, msg.trace_id)
        elif op == "flash":
            yield Event(self.id, op, {"elf": msg.args[0] if msg.args else "", "verified": True}, msg.trace_id)
        else:
            yield Event(self.id, "error", {"op": op, "err": "unknown op"}, msg.trace_id)
