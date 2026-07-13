#!/usr/bin/env bash
# Build motor_pid.elf for the Renode co-sim (Cortex-M3, bare metal, no libc).
set -e
cd "$(dirname "$0")"
GCC="${ARM_GCC:-../../vendor/arm-gcc/bin/arm-none-eabi-gcc}"
"$GCC" -mcpu=cortex-m3 -mthumb -nostdlib -nostartfiles -O2 \
  -Wl,-T,link.ld -o motor_pid.elf main.c
"${GCC%gcc}size" motor_pid.elf
echo "built: $(pwd)/motor_pid.elf"
