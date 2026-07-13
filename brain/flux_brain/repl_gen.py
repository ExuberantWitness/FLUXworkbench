"""Renode platform generation — register-map asset → .repl + .resc skeleton.

The simulation side of the flywheel: the same asset that drives test-plan
probes also generates the simulated MCU. Peripherals are modeled as
ArrayMemory register windows (firmware writes / probes read — behavioral
models can replace them incrementally), and a companion .resc applies every
documented reset value from the asset, so probe-and-assert plans hold on the
simulated target with no hand-written platform work.
"""
from __future__ import annotations

from pathlib import Path
from typing import Any

from . import asset_store

# device-name prefix → (cpu type, flash base/size, sram base/size)
_FAMILIES = {
    "STM32F1": ("cortex-m3", 0x08000000, 0x20000, 0x20000000, 0x5000),
    "STM32": ("cortex-m3", 0x08000000, 0x40000, 0x20000000, 0x10000),
    "HPM": ("rv32imac", 0x80000000, 0x100000, 0x00080000, 0x40000),
}


def _family(device: str) -> tuple[str, int, int, int, int]:
    dev = device.upper()
    for prefix, spec in _FAMILIES.items():
        if dev.startswith(prefix):
            return spec
    return _FAMILIES["STM32"]


def generate_repl(
    asset: dict[str, Any],
    peripherals: list[str] | None = None,
    window: int = 0x400,
) -> str:
    """Emit a minimal .repl: CPU + NVIC + flash + sram + ArrayMemory register
    windows for the selected peripherals (default: all groups GPIO/UART/USART/RCC)."""
    char = asset.get("characterization", {})
    device = char.get("device", {}).get("name", "unknown")
    cpu, flash_base, flash_size, sram_base, sram_size = _family(device)

    want = {p.upper() for p in peripherals} if peripherals else None
    lines = [
        f"// generated from asset {asset.get('asset_id', '?')} ({device}) — do not hand-edit",
        "cpu: CPU.CortexM @ sysbus" if cpu.startswith("cortex") else "cpu: CPU.RiscV32 @ sysbus",
    ]
    if cpu.startswith("cortex"):
        lines += [
            f'    cpuType: "{cpu}"',
            "    nvic: nvic",
            "",
            "nvic: IRQControllers.NVIC @ sysbus 0xE000E000",
            "    -> cpu@0",
        ]
    else:
        lines += [f'    cpuType: "{cpu}"', '    timeProvider: empty']
    lines += [
        "",
        f"flash: Memory.MappedMemory @ sysbus 0x{flash_base:08X}",
        f"    size: 0x{flash_size:X}",
        "",
        f"sram: Memory.MappedMemory @ sysbus 0x{sram_base:08X}",
        f"    size: 0x{sram_size:X}",
    ]
    for p in char.get("peripherals", []):
        name = p["name"]
        group = (p.get("group") or name).upper()
        if want is not None and name.upper() not in want:
            continue
        if want is None and not any(g in group for g in ("GPIO", "UART", "USART", "RCC", "PWR", "DBG")):
            continue
        base = p.get("base_address")
        if not base:
            continue
        lines += [
            "",
            f"// {name}: register window (asset-backed; replace with behavioral model as needed)",
            f"{name.lower()}: Memory.ArrayMemory @ sysbus {base}",
            f"    size: 0x{window:X}",
        ]
    lines.append("")
    return "\n".join(lines)


def generate_resc(asset: dict[str, Any], repl_path: str, peripherals: list[str] | None = None) -> str:
    """Emit a .resc that creates the machine and applies documented reset values."""
    char = asset.get("characterization", {})
    device = char.get("device", {}).get("name", "unknown")
    want = {p.upper() for p in peripherals} if peripherals else None
    lines = [
        f"# generated from asset {asset.get('asset_id', '?')} — machine + reset state",
        "mach create \"flux-sim\"",
        f"machine LoadPlatformDescription @{repl_path}",
    ]
    n = 0
    for p in char.get("peripherals", []):
        if want is not None and p["name"].upper() not in want:
            continue
        base = p.get("base_address")
        if not base:
            continue
        for r in p.get("registers", []):
            rv, off = r.get("reset_value"), r.get("offset")
            if rv in (None, "0x0") or off is None:
                continue
            try:
                addr = int(base, 16) + int(off, 16)
            except (TypeError, ValueError):
                continue
            lines.append(f"sysbus WriteDoubleWord 0x{addr:08X} {rv}")
            n += 1
    lines.append(f"echo \"flux-sim ready: {device}, {n} reset values applied from asset\"")
    lines.append("")
    return "\n".join(lines)


def build_sim_platform(
    chip_query: str,
    out_dir: str,
    peripherals: list[str] | None = None,
) -> dict[str, Any]:
    """register-map asset → {repl, resc} files + sim-platform asset. Returns summary."""
    hits = [a for a in asset_store.search_assets(chip_query, limit=5) if a.get("type") == "register-map"]
    if not hits:
        raise ValueError(f"no register-map asset for: {chip_query}")
    asset = asset_store.get_asset(hits[0]["id"])
    assert asset is not None
    device = asset["characterization"]["device"]["name"]

    out = Path(out_dir)
    out.mkdir(parents=True, exist_ok=True)
    repl_path = out / f"{device.lower()}.repl"
    resc_path = out / f"{device.lower()}.resc"
    repl_path.write_text(generate_repl(asset, peripherals))
    resc_path.write_text(generate_resc(asset, str(repl_path), peripherals))

    platform_asset_id = asset_store.commit_asset({
        "asset_id": f"simplat-{device.lower()}",
        "type": "sim-platform",
        "source": {"kind": "repl-gen", "from_asset": asset["asset_id"]},
        "components": [device, *(peripherals or [])],
        "characterization": {"repl": str(repl_path), "resc": str(resc_path)},
    })
    return {
        "asset_id": platform_asset_id,
        "type": "sim-platform",
        "repl": str(repl_path),
        "resc": str(resc_path),
        "from_asset": asset["asset_id"],
    }
