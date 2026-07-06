# Flux Workbench — native C/C++ tools (Tier 2). v1: openocd embodied-agent driver.
cmake_minimum_required(VERSION 3.22)
project(fluxworkbench_native LANGUAGES C CXX)

set(CMAKE_C_STANDARD 17)
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

# Consumed by the TS base as an N-API addon OR built standalone as a subprocess.
add_subdirectory(openocd)
