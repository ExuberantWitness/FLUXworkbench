"""The four first-class primitives of the Flux runtime.

Ontology is minimal and complete: actor + behavior + state + world.
Every feature in the plan is an instance of exactly one of these — no
special cases (cf. Unix process/file/pipe, ROS node/topic/service).

    Subagent  (actor)    capabilities + message stream + state
    Loop      (behavior) steppable research -> write -> execute -> debug
    Asset     (state)    .flux DevReady, PHM-maintained, LIVRPS-composable
    World     (sim)      DevReady bundle -> scene; multi-physics + world model
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Literal
from uuid import uuid4


# ────────────────────────────────────────────────────────────────────
# uniform stream types — every Subagent speaks Message, emits Event
# ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Message:
    """A unit dispatched to a Subagent. Uniform across all subagent types."""

    target: str
    op: str
    args: tuple[Any, ...] = ()
    kwargs: dict[str, Any] = field(default_factory=dict)
    trace_id: str = field(default_factory=lambda: uuid4().hex)


@dataclass(frozen=True)
class Event:
    """A unit emitted by a Subagent/Loop/World — the uniform observation stream."""

    source: str
    kind: str  # 'propose'|'predict'|'execute'|'measure'|'attribute'|'log'|'error'
    data: dict[str, Any] = field(default_factory=dict)
    trace_id: str = ""


# ────────────────────────────────────────────────────────────────────
# Subagent — actor
# ────────────────────────────────────────────────────────────────────

class Subagent(ABC):
    """An actor with capabilities + a message stream + state.

    All actor kinds are uniform instances of this base: device (multi-OpenOCD,
    CAN, serial), camera (work-process monitoring), VLA (physical-node control),
    solver (Newton / FLUXVortex / FluxPhased), cloud service, GUI-operator
    (TARS computer-use — fallback once headless generation is exhausted).
    """

    id: str
    capabilities: tuple[str, ...] = ()

    @abstractmethod
    async def start(self) -> None: ...

    @abstractmethod
    async def stop(self) -> None: ...

    @abstractmethod
    async def step(self, msg: Message) -> AsyncIterator[Event]:
        """Invoke one capability; yield zero or more Events (a trace)."""
        ...
        yield  # pragma: no cover


# ────────────────────────────────────────────────────────────────────
# Loop — behavior (steppable, observable, intervenable)
# ────────────────────────────────────────────────────────────────────

LoopPhase = Literal["research", "write", "execute", "debug"]
Intercept = Literal["approve", "reject", "defer"]


class Loop(ABC):
    """A steppable ``research -> write -> execute -> debug`` loop.

    Composable: ASPIRE (per-primitive trace + failure attribution + Evo
    search), Flux-Insight PES (Claim-Chain-grounded), the predict-before-act
    intercept, self-dev, background PHM maintenance are all Loop
    compositions over Subagents. Observable (one Event per step) and
    intervenable (human approve / 推演 block between steps).
    """

    @abstractmethod
    async def run(self, goal: str, dispatch) -> AsyncIterator[Event]:
        """Drive the loop toward ``goal`` via ``dispatch``; yield a trace."""
        ...
        yield  # pragma: no cover

    @abstractmethod
    async def intervene(self, decision: Event) -> Intercept:
        """Human / 推演 interception point between steps."""
        ...


# ────────────────────────────────────────────────────────────────────
# Asset — state (.flux DevReady, PHM-maintained, composable)
# ────────────────────────────────────────────────────────────────────

class Asset(ABC):
    """A ``.flux`` DevReady asset — typed, versioned, LIVRPS-composable, PHM-live.

    Marketplace listings, skills (MIND layer), flywheel training data,
    Foundation fuel, BOM/schematic/vendor-SDK ingests are all Asset ops.
    PHM = continuously re-calibrated, health-tracked, pruned (background).
    """

    @abstractmethod
    async def calibrate(self, measurement: Any) -> None:
        """PHM: re-calibrate against a new measurement."""
        ...

    @abstractmethod
    async def health(self) -> dict[str, Any]:
        """PHM: health / drift / staleness status."""
        ...

    @abstractmethod
    async def export(self, fmt: Literal["usd", "urdf", "mcap", "flux"]) -> bytes: ...


# ────────────────────────────────────────────────────────────────────
# World — sim (DevReady bundle -> scene)
# ────────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Bundle:
    """Portable push payload — manifest + asset ref + engine contract.

    UnitPort-style: one canonical semantic, per-engine lowering at launch
    (Newton / IsaacLab / MuJoCo / world-model).
    """

    asset_ref: str
    engine: str  # 'newton' | 'isaaclab' | 'mujoco' | 'world-model'
    contract: dict[str, Any] = field(default_factory=dict)


@dataclass
class Scene:
    engine: str
    state: dict[str, Any] = field(default_factory=dict)


class World(ABC):
    """A simulation that ingests a DevReady bundle and runs.

    Multi-physics first-principles (Newton / FLUXVortex / FluxPhased) primary,
    world-model surrogate secondary; fidelity tier chosen per action
    (ai-judge / world-model / first-principles / real-hardware).
    """

    @abstractmethod
    async def push(self, bundle: Bundle) -> Scene: ...

    @abstractmethod
    async def predict(self, scene: Scene, action: Any) -> Any:
        """predict-before-act: a cheap predict for the safety gate."""
        ...
