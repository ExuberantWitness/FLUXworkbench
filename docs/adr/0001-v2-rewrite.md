# ADR 0001 — v2 rewrite (microkernel + four-primitive studio)

- **Status**: accepted (branch `v2`)
- **Date**: 2025-07-05
- **Supersedes**: v0 (`main` — Python flux-runtime host + vendored openwork + single-file UI)

## Context

v0 is a "toy": Python FastAPI host + single-file HTML UI + headless-driven vendored openwork (Electron). The goal is a GitHub-flagship "robot-dev Claude Code" that **merges and surpasses vendor AI-agent IDEs** — VSCode-like, hardware-enhanced, solving six concrete pain points (CubeMX lock-in, schematic ≠ OCR, instruments, asset/context sprawl, over-approval, 2nd-class physical subagents).

## Decision

Rewrite as **two cores**:

1. **Infrastructure core**: unified `3-axis × 2-resource` scheduler (flow/time/priority × compute/storage), all-process microkernel, capability-signed modules, uORB-over-Zenoh bus. "Hardware-first, agent-assisted."
2. **Application core**: four primitives (`subagent`/`loop`/`devready`/`simulation`) + workflow — all `Task` specializations.

**Three languages, VSCode-model**: TS base (Electron + kernel + UI) / Python execution (single process, OpenRath-reconstructed, produces flow) / C tool (OpenOCD embodied agent). Hardware path doesn't require Python.

## Consequences

- **+** port v0's clean `primitives.py` ontology (Message/Event→uORB, Loop.intervene→policy gate, Bundle/Scene→sim) into TS Task model — design continuity.
- **+** hardware-first priority + capability auth + embodied agents solve pain points ⑥/⑤/④.
- **−** polyglot (TS+Python+C) — contributor friction; mitigated by clean Zenoh boundaries + per-layer docs.
- **−** Zenoh three-language perf is a v1 **gate** (spike before building); all-process IPC tax accepted.
- **−** months of work; mitigated by "kernel-skeleton-first" delivery and the分阶段 playable (TS+C hardware-tool mode first, Python brain as v1.5).

## Alternatives considered (rejected)

- **Stay on v0** (Python host + headless openwork): rejected as "toy" — headless stitching, no Warp UX, no hardware-first scheduling.
- **Pure TS / Pure Python**: TS-only loses AI ecosystem; Python-only loses Warp desktop UX. Hybrid VSCode-model wins both.
- **Eclipse Theia** instead of Electron+React+Monaco: rejected — user wants plain Electron (low onboarding via VSCode-style layout, not Theia framework).
- **OpenRath as the brain (full adopt)**: rejected — kernel leads (TS); OpenRath is reconstructed material for the Python execution layer only.
- **C-prime "everything is a Task"** vs four distinct primitives: resolved — four primitives = Task specializations (coherence).

## Migration

- Branch `v2` carries the rewrite; `main` keeps v0 for history.
- Vendored `apps/` `packages/` (openwork) + `flux-runtime/` + `ui/index.html` are deleted on `v2` once the kernel skeleton is functional (separate commit; git history preserves them).
- v0 `flux-runtime/primitives.py` ontology is ported (see `docs/architecture.md` §Ported).
