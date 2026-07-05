"""Backend engines plugged into the Flux shell as Subagents.

The Flux runtime (this Python process + web UI) is the host. Heavy external
engines are wrapped as Subagents so the Coordinator schedules them uniformly
— no special-casing:

    FluxInsightSubagent  research brain (Claim-Chain; Loop's research/write/debug)
    OpenWorkSubagent     agent-cowork engine (OpenCode; Loop's write/execute)

Lifecycle is real (spawn/stop the engine subprocess). HTTP dispatch is
best-effort against the researched dashboards/server APIs — verify the exact
request shapes against a live engine when you first connect one.
"""

from .flux_insight import FluxInsightSubagent
from .openwork import OpenWorkSubagent

__all__ = ["FluxInsightSubagent", "OpenWorkSubagent"]
