# OpenOCD embodied-agent driver (Tier 2 C tool).
# v1: standalone subprocess speaking TCL RPC to an OpenOCD binary (OpenOCD owns the RT thread when hard-RT lands).
# Future: N-API addon form factor; the `hw-module` interface in app/ wraps whichever form.
project(flux_openocd LANGUAGES C)

add_library(flux_openocd STATIC
    openocd_rpc.c
)
target_include_directories(flux_openocd PUBLIC ${CMAKE_CURRENT_SOURCE_DIR})

# Standandalone CLI driver for v1 (run by TS supervisor as a subprocess).
add_executable(flux_openocd_cli openocd_cli.c)
target_link_libraries(flux_openocd_cli PRIVATE flux_openocd)
