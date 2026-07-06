"""Flux Brain entrypoint — single Python process supervised by the TS kernel.

v1 skeleton: connect to Zenoh, subscribe to uORB command topics, produce
workflow flow (DAG) for the board-bringup vertical, publish events. OpenRath
Session/Workflow reconstruction wired during build-task #4.
"""
from __future__ import annotations

import logging
import sys

log = logging.getLogger("flux_brain")


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    log.info("flux-brain starting (v1 skeleton)")

    # TODO(build-task #4): Zenoh session, uORB topic subscribe/publish,
    # OpenRath-reconstructed Session/Workflow, Anthropic agent loop.
    try:
        import zenoh  # noqa: F401  (eclipse-zenoh)
    except ImportError:
        log.warning("eclipse-zenoh not installed yet — install with: pip install eclipse-zenoh")

    log.info("flux-brain skeleton ready (no-op); wire Zenoh + OpenRath in build-task #4")
    return 0


if __name__ == "__main__":
    sys.exit(main())
