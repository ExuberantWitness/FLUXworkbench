"""Flux Workbench runtime — the four first-class primitives.

A small uniform runtime (cf. Unix process/file/pipe, ROS node/topic/service).
Every feature is an instance of one of four object types; no special cases:

    Subagent  (actor)    capabilities + message stream + state
    Loop      (behavior) steppable research -> write -> execute -> debug
    Asset     (state)    .flux DevReady, PHM-maintained, composable
    World     (sim)      DevReady bundle -> scene; multi-physics + world model

The Coordinator schedules them. See plan: witty-growing-dragon.md.
"""

from .primitives import (
    Subagent,
    Loop,
    Asset,
    World,
    Message,
    Event,
    Bundle,
    Scene,
)
from .coordinator import Coordinator

__all__ = [
    "Subagent",
    "Loop",
    "Asset",
    "World",
    "Message",
    "Event",
    "Bundle",
    "Scene",
    "Coordinator",
]
