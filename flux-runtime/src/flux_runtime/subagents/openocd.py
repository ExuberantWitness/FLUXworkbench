"""OpenOCD device subagent — one instance per JTAG/SWD target.

Grounded in FLUXLOOP_hardware/guideline.md:
  §1   one-liner flash command  (program <elf> verify; reset run)
  §5.1 CPU CSRs / IDCODE         (reg mvendorid/marchid/... ; idcode 0x1000563d)
  §12  Message RAM readback       (mdw 0x400064C0 1  -> TXBC)
  §15  dual debugger              (HPM :3333 sdk_env | STM32 :3334 xpack)

Multi-instance = N OpenOCDSubagent objects, each spawning its own OpenOCD
process on distinct gdb/telnet ports. The Coordinator schedules them
uniformly (multi-task, multi-thread); device vs physics vs cloud is only a
capability difference.

OpenOCD pitfalls encoded (so they never recur — these cost days in guideline.md):
  - paths passed to OpenOCD are Jim-Tcl: backslash is escape -> use forward slash
  - 'program <elf> reset' leaves the core halted -> use explicit 'reset run'
  - STM32 targets are stripped from the sdk_env OpenOCD build -> needs xpack
"""
from __future__ import annotations

import asyncio
import re
from typing import AsyncIterator

from ..primitives import Event, Message, Subagent

# Per-target defaults (board / probe / cfg). HPM via sdk_env patched OpenOCD;
# STM32G4 via xpack OpenOCD (sdk_env build strips stm32 targets — guideline §15).
_TARGET_DEFAULTS = {
    "hpm": dict(board="hpm6e00evk", probe="ft2232",
                cfg="hpm6e00_all_in_one.cfg"),
    "stm32": dict(board="stm32g4x", probe="stlink",
                  cfg="interface/stlink.cfg"),
}

_HEX = re.compile(r"0x[0-9a-fA-F]+")


class OpenOCDSubagent(Subagent):
    capabilities = (
        "connect", "disconnect", "halt", "resume",
        "read_register", "read_mem", "write_mem", "read_idcode", "flash",
    )

    def __init__(
        self,
        id: str,
        *,
        openocd_exe: str,
        cfg_dir: str,
        target: str = "hpm",
        gdb_port: int = 3333,
        telnet_port: int = 4444,
        sdk_base: str = "",
        board: str | None = None,
        probe: str | None = None,
    ) -> None:
        self.id = id
        self.openocd_exe = openocd_exe
        self.cfg_dir = cfg_dir
        self.target = target
        self.gdb_port = gdb_port
        self.telnet_port = telnet_port
        self.sdk_base = sdk_base
        d = _TARGET_DEFAULTS.get(target, {})
        self.board = board or d.get("board", "")
        self.probe = probe or d.get("probe", "ft2232")
        self.cfg = d.get("cfg", "hpm6e00_all_in_one.cfg")
        self._proc: asyncio.subprocess.Process | None = None
        self._telnet: tuple | None = None  # (reader, writer)

    # ── lifecycle ───────────────────────────────────────────────────
    async def start(self) -> None:
        """Spawn a persistent OpenOCD gdbserver (init; halt, no shutdown)."""
        argv = [
            self.openocd_exe, "-s", self.cfg_dir,
            "-c", self._setup_commands(),
            "-f", self.cfg,
            "-c", f"init; halt; gdb_port {self.gdb_port}; "
                  f"telnet_port {self.telnet_port}",
        ]
        self._proc = await asyncio.create_subprocess_exec(
            *argv,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        # Wait for the telnet port to come up.
        for _ in range(40):
            try:
                self._telnet = await asyncio.open_connection("127.0.0.1", self.telnet_port)
                break
            except OSError:
                await asyncio.sleep(0.25)
        else:
            raise RuntimeError(f"{self.id}: OpenOCD telnet never came up on {self.telnet_port}")
        await self._read_until_prompt()  # drain banner

    async def stop(self) -> None:
        if self._telnet:
            self._telnet[1].close()
            self._telnet = None
        if self._proc and self._proc.returncode is None:
            self._proc.terminate()
            try:
                await asyncio.wait_for(self._proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self._proc.kill()
        self._proc = None

    # ── dispatch (Subagent.step) ────────────────────────────────────
    async def step(self, msg: Message) -> AsyncIterator[Event]:
        op = msg.op
        try:
            if op == "connect":
                out = "ok"  # connection is established in start()
            elif op == "disconnect":
                await self.stop(); out = "ok"
            elif op == "halt":
                out = await self._cmd("halt")
            elif op == "resume":
                out = await self._cmd("resume")
            elif op == "read_register":
                out = await self._cmd(f"reg {msg.args[0]}")
            elif op == "read_mem":
                addr = msg.args[0]
                words = msg.args[1] if len(msg.args) > 1 else 1
                out = await self._cmd(f"mdw 0x{addr:x} {int(words)}")
            elif op == "write_mem":
                out = await self._cmd(f"mww 0x{msg.args[0]:x} 0x{msg.args[1]:x}")
            elif op == "read_idcode":
                out = await self._cmd("jtag apis_idcode")
            elif op == "flash":
                out = await self._flash(msg.args[0])
            else:
                yield Event(self.id, "error", {"op": op, "err": "unknown op"}, msg.trace_id)
                return
            yield Event(self.id, op, {"out": out}, msg.trace_id)
        except Exception as e:  # surface as a trace Event, don't crash the loop
            yield Event(self.id, "error", {"op": op, "err": repr(e)}, msg.trace_id)

    # ── OpenOCD telnet command channel ──────────────────────────────
    async def _cmd(self, command: str) -> str:
        if not self._telnet:
            raise RuntimeError(f"{self.id}: not connected (call start() first)")
        _, writer = self._telnet
        writer.write((command + "\n").encode())
        await writer.drain()
        return await self._read_until_prompt()

    async def _read_until_prompt(self, timeout: float = 10.0) -> str:
        reader, _ = self._telnet
        lines: list[str] = []
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=timeout)
            s = line.decode(errors="replace").rstrip()
            if s.endswith(">"):  # OpenOCD telnet prompt
                if s[:-1].strip():
                    lines.append(s[:-1])
                break
            if s:
                lines.append(s)
        return "\n".join(lines)

    async def _flash(self, elf: str) -> str:
        # guideline §1 pitfall #1: Jim-Tcl eats backslashes -> forward slashes.
        # guideline §1 pitfall #4: 'program ... reset' leaves core halted
        # -> use explicit 'reset run' (NOT 'program <elf> verify reset').
        elf_fwd = elf.replace("\\", "/")
        return await self._cmd(f"program {elf_fwd} verify reset run")

    def _setup_commands(self) -> str:
        parts: list[str] = []
        if self.sdk_base and self.target == "hpm":
            parts.append(f"set HPM_SDK_BASE {self.sdk_base.replace(chr(92), '/')}")
        if self.board:
            parts.append(f"set BOARD {self.board}")
        if self.probe:
            parts.append(f"set PROBE {self.probe}")
        return "; ".join(parts)
