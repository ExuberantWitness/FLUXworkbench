"""Reconstructed Session primitive — adapted from OpenRath ``session/`` (BSD-3-Clause).

Session = ordered, append-only **ChunkTable** + **Lineage**. ``fork`` / ``detach``
copy the chunk table only (the "memory page" lineage model). This is the storage
unit the kernel's storage-scheduler will manage (residency / eviction / compress
wired in later build-tasks).

Re-implemented (not copied) under BSD-3-Clause; semantics kept compatible so future
OpenRath interop is straightforward. See brain/vendor/README.md for the pin.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass, field, replace
from enum import Enum
from typing import Any, Iterator


class ChunkKind(str, Enum):
    SYSTEM = "system"
    USER = "user"
    ASSISTANT = "assistant"
    TOOL_RESULT = "tool_result"
    EVENT = "event"  # uORB event appended to the transcript (Flux extension)


@dataclass(frozen=True, slots=True)
class ChunkRow:
    """Immutable row in chronological order."""

    kind: ChunkKind
    payload: dict[str, Any]


def event_chunk(topic: str, source: str, data: dict[str, Any] | None = None) -> ChunkRow:
    """Wrap a uORB Event as a chunk row (Flux extension over OpenRath's set)."""
    return ChunkRow(kind=ChunkKind.EVENT, payload={"topic": topic, "source": source, "data": data or {}})


def user_text_chunk(text: str) -> ChunkRow:
    return ChunkRow(kind=ChunkKind.USER, payload={"content": text})


@dataclass(frozen=True, slots=True)
class ChunkTable:
    """Append-only chronological chunk list (immutable; extend returns a new one)."""

    rows: tuple[ChunkRow, ...] = ()

    def __len__(self) -> int:
        return len(self.rows)

    def __getitem__(self, index: int | slice) -> ChunkRow | tuple[ChunkRow, ...]:
        return self.rows[index]

    def __iter__(self) -> Iterator[ChunkRow]:
        return iter(self.rows)

    def extend(self, *more: ChunkRow) -> "ChunkTable":
        return ChunkTable(rows=self.rows + tuple(more))


class LineageKind(str, Enum):
    LEAF = "leaf"
    FORK = "fork"
    DETACH = "detach"
    MERGE = "merge"


@dataclass
class Lineage:
    parent_ids: tuple[str, ...] = ()
    operator: str = ""
    kind: LineageKind = LineageKind.LEAF
    extras: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "parent_ids": list(self.parent_ids),
            "operator": self.operator,
            "kind": self.kind.value,
            "extras": self.extras,
        }


@dataclass
class Session:
    """A memory page: chunk table + lineage. Append returns a new Session (the
    lineage trail records the derivation)."""

    id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    chunk_table: ChunkTable = field(default_factory=ChunkTable)
    lineage: Lineage = field(default_factory=Lineage)

    def append(self, row: ChunkRow) -> "Session":
        return replace(self, chunk_table=self.chunk_table.extend(row))

    def fork(self, operator: str = "fork") -> "Session":
        """Branch: copy chunk table, new id, lineage parent = self."""
        return Session(
            chunk_table=self.chunk_table,
            lineage=Lineage(parent_ids=(self.id,), operator=operator, kind=LineageKind.FORK),
        )

    def detach(self, operator: str = "detach") -> "Session":
        """Detach (swap-out friendly): same data shape as fork, semantics flag differs."""
        return Session(
            chunk_table=self.chunk_table,
            lineage=Lineage(parent_ids=(self.id,), operator=operator, kind=LineageKind.DETACH),
        )

    def brief(self) -> str:
        kinds: dict[str, int] = {}
        for r in self.chunk_table.rows:
            kinds[r.kind.value] = kinds.get(r.kind.value, 0) + 1
        return f"Session({self.id[:8]} chunks={len(self.chunk_table)} {kinds} lineage={self.lineage.kind.value})"


def create_session(*rows: ChunkRow, operator: str = "create") -> Session:
    s = Session(chunk_table=ChunkTable(rows))
    s.lineage = Lineage(operator=operator, kind=LineageKind.LEAF)
    return s
