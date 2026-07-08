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
