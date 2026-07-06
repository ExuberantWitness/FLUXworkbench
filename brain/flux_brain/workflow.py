"""Reconstructed Workflow primitive — adapted from OpenRath ``flow/`` (BSD-3-Clause).

Two faces, matching the orchestration boundary (decision #20: Python produces
flow, TS dispatches):

- **Declarative DAG** (v1): ``Workflow`` = named steps + deps; ``topo_order()`` +
  ``to_dict()`` produce a serializable flow descriptor the TS kernel schedules.
- **Imperative forward()** (OpenRath-compat): a ``run(session, emit)`` that threads
  a Session through steps for in-process execution (used when the brain runs a
  workflow locally, e.g. dry-run / replay).

Re-implemented (not copied) under BSD-3-Clause. See brain/vendor/README.md for the pin.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

from flux_brain.session import Session


@dataclass(frozen=True, slots=True)
class Step:
    """A DAG node: emits a uORB command/event when dispatched."""

    name: str
    op: str  # uORB command topic, e.g. "cmd.flash" / "cmd.halt" / "devready.commit"
    deps: tuple[str, ...] = ()
    params: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {"name": self.name, "op": self.op, "deps": list(self.deps), "params": self.params}


class Workflow:
    """Named DAG of Steps. Python produces this; the TS scheduler dispatches it."""

    def __init__(self, name: str, steps: list[Step], description: str = "") -> None:
        self.name = name
        self.description = description
        self.steps: dict[str, Step] = {s.name: s for s in steps}

    def topo_order(self) -> list[Step]:
        """Kahn's algorithm; raises on cycles/missing deps."""
        resolved: list[Step] = []
        done: set[str] = set()
        remaining = list(self.steps.values())
        while remaining:
            progressed = False
            nxt: list[Step] = []
            for s in remaining:
                if all(d in done for d in s.deps):
                    resolved.append(s)
                    done.add(s.name)
                    progressed = True
                else:
                    nxt.append(s)
            if not progressed:
                missing = [s.name for s in nxt]
                raise ValueError(f"workflow {self.name!r} cycle/missing-deps: {missing}")
            remaining = nxt
        return resolved

    def to_dict(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "description": self.description,
            "steps": [s.to_dict() for s in self.steps.values()],
        }

    # OpenRath-compat imperative face (in-process run; emit called per step) ──────
    def run(self, session: Session, emit: Callable[[Step], None]) -> Session:
        for step in self.topo_order():
            emit(step)
            session = session.append(_step_chunk(step))
        return session

    def __repr__(self) -> str:
        return f"Workflow({self.name!r}, {len(self.steps)} steps)"


def _step_chunk(step: Step):
    from flux_brain.session import ChunkRow, ChunkKind
    return ChunkRow(kind=ChunkKind.EVENT, payload={"topic": "workflow.step", "source": "workflow",
                                                    "data": step.to_dict()})


def board_bringup_workflow(elf: str = "firmware.elf") -> Workflow:
    """The v1 vertical as a declarative DAG."""
    return Workflow(
        name="board-bringup",
        description="HPM6E00 bring-up: probe → flash → characterize → commit asset",
        steps=[
            Step("probe", "cmd.halt", deps=[], params={}),
            Step("flash", "cmd.flash", deps=("probe",), params={"elf": elf}),
            Step("characterize", "agent.characterize", deps=("flash",)),
            Step("commit", "devready.commit", deps=("characterize",)),
        ],
    )
