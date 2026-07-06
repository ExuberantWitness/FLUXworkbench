"""Flux Workbench — Python execution layer (Tier 3).

Single process. OpenRath-reconstructed primitives. Produces workflow ``flow``
(DAG); the TS kernel dispatches along flow+time+priority. Connects over Zenoh
(uORB topics). See docs/architecture.md.
"""

__version__ = "0.1.0"
