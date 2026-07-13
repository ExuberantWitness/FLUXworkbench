#!/usr/bin/env python3
"""Stateful mock OpenOCD — line-protocol board simulator for HIL runs.

Replies use REAL OpenOCD output formats so the HilRunner probe parser is
exercised identically in mock and real mode:
    mdw:  "0x40013800: 000000c0 20000000"
    reg:  "pc (/32): 0x08000130"
    flash:"wrote 4096 bytes from file demo.elf in 0.10s (40.0 KiB/s)"

Scenario JSON (env FLUX_MOCK_SCENARIO, default spike/mock-scenarios/
stm32f103_default.json):
    regs           {name: "0x..."}         reg <name> lookups
    mem            {"0xADDR": "0x..."}     mdw lookups (static)
    sequences      {"0xADDR": ["0x..",..]} post-flash reads pop these in order,
                                           then repeat the last value
    flash_effects  {mem: {...}, activate_sequences: true}
"""
import json
import os
import sys
from pathlib import Path

SCENARIO_PATH = os.environ.get(
    "FLUX_MOCK_SCENARIO",
    str(Path(__file__).resolve().parent / "mock-scenarios" / "stm32f103_default.json"),
)

try:
    scenario = json.loads(Path(SCENARIO_PATH).read_text())
except (OSError, json.JSONDecodeError) as e:
    scenario = {}
    sys.stderr.write(f"mock-openocd: scenario load failed ({e}); empty board\n")

regs: dict = dict(scenario.get("regs", {}))
mem: dict = {k.lower(): v for k, v in scenario.get("mem", {}).items()}
sequences: dict = {k.lower(): list(v) for k, v in scenario.get("sequences", {}).items()}
flash_effects: dict = scenario.get("flash_effects", {})
flashed = False


def word(v) -> str:
    return f"{int(str(v), 16) if isinstance(v, str) else int(v):08x}"


def read_mem(addr: str) -> str:
    addr = addr.lower()
    if flashed and addr in sequences and sequences[addr]:
        seq = sequences[addr]
        return word(seq.pop(0) if len(seq) > 1 else seq[0])
    return word(mem.get(addr, 0))


sys.stderr.write(f"mock-openocd ready (scenario: {Path(SCENARIO_PATH).name})\n")
sys.stderr.flush()

for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    parts = line.split()
    head = parts[0]
    if head == "halt":
        print("target state: halted")
    elif head == "flash":
        elf = parts[-1] if len(parts) > 1 else "?"
        flashed = True
        for k, v in flash_effects.get("mem", {}).items():
            mem[k.lower()] = v
        print(f"wrote 4096 bytes from file {elf} in 0.10s (40.0 KiB/s)")
    elif head == "mdw":
        addr = parts[1] if len(parts) > 1 else "0x0"
        count = int(parts[2]) if len(parts) > 2 else 1
        base = int(addr, 16)
        words = [read_mem(hex(base + 4 * i)) for i in range(count)]
        print(f"0x{base:08x}: " + " ".join(words))
    elif head == "reg":
        name = parts[1] if len(parts) > 1 else "pc"
        val = regs.get(name, "0x00000000")
        print(f"{name} (/32): {val}")
    elif head == "reset":
        flashed_note = "run" if "run" in parts else "halt"
        print(f"reset ({flashed_note}) complete")
    else:
        print(f"?unknown:{head}")
    sys.stdout.flush()
