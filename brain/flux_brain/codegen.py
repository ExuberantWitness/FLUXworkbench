"""Peripheral codegen — pain point ① (CubeMX UI-lock-in).

Generates peripheral/pin/clock init code from a declarative JSON config,
replacing STM32CubeMX's GUI-dependent codegen with a scriptable/agent-driven
generator. Agent can call this to produce HPM_SDK / STM32 HAL / register-level
init code without touching CubeMX's GUI.
"""
from __future__ import annotations

import json
from typing import Any

# HPM6E00 pin/port naming convention (HPMicro SDK)
HPM_PORTS = ["PA", "PB", "PC", "PD", "PE"]


def gen_gpio_init(config: dict[str, Any]) -> str:
    """Generate GPIO init code from a pin config.

    Example config:
        {"pins": [{"port":"PA","num":0,"mode":"output","pull":"none"},
                  {"port":"PB","num":7,"mode":"input","pull":"up"}]}
    """
    lines = ["#include <hpm_gpio.h>", "", "void board_gpio_init(void) {"]
    for pin in config.get("pins", []):
        port = pin.get("port", "PA")
        num = pin.get("num", 0)
        mode = pin.get("mode", "output")
        pull = pin.get("pull", "none")
        if mode == "output":
            lines.append(
                f"    gpio_set_pin_output(HPM_GPIO, {port}, {num});"
            )
            if pull == "up":
                lines.append(f"    gpio_enable_pin_output(HPM_GPIO, {port}, {num});")
        elif mode == "input":
            lines.append(f"    gpio_set_pin_input(HPM_GPIO, {port}, {num});")
            if pull == "up":
                lines.append(f"    gpio_config_pin_pull_up(HPM_GPIO, {port}, {num});")
    lines.append("}")
    return "\n".join(lines)


def gen_clock_init(config: dict[str, Any]) -> str:
    """Generate clock init code from a clock config."""
    freq = config.get("cpu_freq_mhz", 480)
    return (
        f"#include <hpm_clock.h>\n\n"
        f"void board_clock_init(void) {{\n"
        f"    // CPU clock: {freq} MHz\n"
        f"    clock_set_cpu_frequency({freq} * 1000000ULL);\n"
        f"}}"
    )


def gen_peripheral_init(peripheral: str, config: dict[str, Any]) -> str:
    """Generate peripheral init code (UART/SPI/I2C/CAN stubs)."""
    p = peripheral.upper()
    if p == "UART":
        baud = config.get("baud", 115200)
        return (
            f"#include <hpm_uart.h>\n\n"
            f"void board_{peripheral}_init(void) {{\n"
            f"    uart_config_t cfg = {{.baud_rate = {baud}}};\n"
            f"    hpm_uart_init(HPM_UART0, &cfg);\n"
            f"}}"
        )
    if p == "SPI":
        return f"// SPI init stub — clock={config.get('clock_hz', 1000000)} Hz\n// hpm_spi_init(...)"
    if p == "I2C":
        return f"// I2C init stub — addr=0x{config.get('addr', 0x50):02X}\n// hpm_i2c_init(...)"
    if p == "CAN":
        return f"// CAN init stub — bitrate={config.get('bitrate', 500000)}\n// hpm_can_init(...)"
    return f"// {peripheral} init stub"


def generate_board_init(config: dict[str, Any]) -> dict[str, str]:
    """Full board init codegen from a unified config.

    Returns dict of filename → generated C code.
    """
    files: dict[str, str] = {}
    if "gpio" in config:
        files["board_gpio.c"] = gen_gpio_init(config["gpio"])
    if "clock" in config:
        files["board_clock.c"] = gen_clock_init(config["clock"])
    for periph, pconfig in config.get("peripherals", {}).items():
        files[f"board_{periph}.c"] = gen_peripheral_init(periph, pconfig)
    files["board_init.h"] = (
        "#ifndef BOARD_INIT_H\n#define BOARD_INIT_H\n"
        + "\n".join(f"void board_{n}_init(void);" for n in ["gpio", "clock"])
        + "\n#endif"
    )
    return files


# ── Asset-driven backends (pain point ①: CubeMX replacement, register truth
#    from the asset store instead of hand-written templates) ─────────────────

def gen_register_init(regmap_slice: dict[str, Any], config: dict[str, Any] | None = None) -> str:
    """Register-level C init emitted from a register-map asset slice.
    Every address/mask comes from the asset (SVD/datasheet provenance)."""
    config = config or {}
    dev = regmap_slice.get("device", {}).get("name", "unknown")
    src = regmap_slice.get("asset_id", "?")
    lines = [
        f"/* {dev} register-level init — generated from asset {src}.",
        " * Addresses, offsets and field masks are asset-backed (zero hallucination). */",
        "#include <stdint.h>",
        "#define REG(a) (*(volatile uint32_t *)(a))",
        "",
    ]
    for p in regmap_slice.get("peripherals", []):
        base = p.get("base_address")
        if not base:
            continue
        pname = p["name"]
        lines.append(f"/* {pname} @ {base} — {p.get('description', '')[:60]} */")
        lines.append(f"#define {pname}_BASE {base}u")
        for r in p.get("registers", [])[:12]:
            off = r.get("offset") or "0x0"
            lines.append(f"#define {pname}_{r['name']} REG({pname}_BASE + {off})")
            for f in r.get("fields", [])[:8]:
                mask = ((1 << f["bit_width"]) - 1) << f["bit_offset"]
                lines.append(f"#define {pname}_{r['name']}_{f['name']}_MASK 0x{mask:08X}u")
        lines.append("")
        lines.append(f"void {pname.lower()}_init(void) {{")
        for r in p.get("registers", []):
            rv = r.get("reset_value")
            if rv and config.get("emit_reset_writes"):
                lines.append(f"    REG({pname}_BASE + {r.get('offset', '0x0')}) = {rv}u; /* reset: {r['name']} */")
        init = config.get("writes", {}).get(pname, [])
        for w in init:
            lines.append(f"    REG({pname}_BASE + {w['offset']}) = {w['value']}u; /* {w.get('why', '')} */")
        lines.append("}")
        lines.append("")
    return "\n".join(lines)


def gen_zephyr_overlay(regmap_slice: dict[str, Any], config: dict[str, Any] | None = None) -> dict[str, str]:
    """Zephyr-flavoured output: devicetree overlay + prj.conf fragment.
    In the Zephyr world the CubeMX replacement is declarative config, not C."""
    config = config or {}
    parts_overlay = []
    parts_conf = ["# generated from register-map asset " + regmap_slice.get("asset_id", "?")]
    for p in regmap_slice.get("peripherals", []):
        label = p["name"].lower()
        parts_overlay.append(
            f"&{label} {{\n    status = \"okay\";\n"
            + (f"    current-speed = <{config.get('baud', 115200)}>;\n" if "USART" in p["name"].upper() or "UART" in p["name"].upper() else "")
            + "};")
        if "USART" in p["name"].upper() or "UART" in p["name"].upper():
            parts_conf.append("CONFIG_SERIAL=y")
        if "GPIO" in p["name"].upper():
            parts_conf.append("CONFIG_GPIO=y")
    return {
        "app.overlay": "/* generated from asset " + regmap_slice.get("asset_id", "?") + " */\n" + "\n\n".join(parts_overlay) + "\n",
        "prj.conf": "\n".join(dict.fromkeys(parts_conf)) + "\n",
    }


def gen_from_regmap(regmap_slice: dict[str, Any], backend: str = "register",
                    config: dict[str, Any] | None = None) -> dict[str, str]:
    """Dispatch: register-map asset slice → generated files by backend."""
    if backend == "zephyr_dts":
        return gen_zephyr_overlay(regmap_slice, config)
    if backend == "hpm_sdk":
        return generate_board_init(config or {})
    name = regmap_slice.get("peripherals", [{}])[0].get("name", "periph").lower()
    return {f"board_{name}.c": gen_register_init(regmap_slice, config)}
