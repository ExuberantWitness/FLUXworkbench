# brain/vendor — reference sources (解构重构)

This directory holds upstream projects whose primitives we **reconstruct** into
`flux_brain/` (decision #11: OpenRath = reconstructed material, not a dependency).
The snapshots themselves are gitignored (kept locally for reference only) — the
**reconstructed IP lives in `flux_brain/`** and is what ships.

## OpenRath

- **Upstream**: https://github.com/Rath-Team/OpenRath
- **Pinned commit**: `f993fc8d378dd032313a58ccc38770d546639fce` (Merge pull request #42)
- **License**: BSD-3-Clause
- **Reconstruct locally** (not committed — 44 MB snapshot):
  ```bash
  git clone --depth 1 https://github.com/Rath-Team/OpenRath.git brain/vendor/openrath
  ```
- **What we extract → reconstruct**:
  - `session/` (ChunkTable, Session, fork/detach, lineage) → `flux_brain/session.py`
  - `flow/` (Workflow, DAG orchestration) → `flux_brain/workflow.py`
  - `llm/` clients, memory backends, config → **dropped** (we use Anthropic SDK + our kernel)

Re-implemented (not copied) under BSD-3-Clause; attribution to the Rath team. See
the per-file headers in `flux_brain/session.py` / `flux_brain/workflow.py`.
