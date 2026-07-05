"""Flux runtime HTTP/WebSocket server — the UI-facing surface.

Exposes the runtime (Coordinator + Subagents) so a browser UI can:
  GET  /api/subagents            list registered subagents + capabilities
  POST /api/dispatch             dispatch a Message, return the Event trace
  WS   /ws/events                live event stream
  GET  /                         the UI (single-file)

By default registers two MockOpenOCDSubagents (HPM :3333 + STM32 :3334,
guideline §15 dual-target) so the UI is demonstrable with no hardware.
Swap in real OpenOCDSubagent when a board is attached.
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from collections import deque
from pathlib import Path
from typing import Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .backends import FluxInsightSubagent, OpenWorkSubagent
from .coordinator import Coordinator
from .mock import MockOpenOCDSubagent
from .primitives import Event, Message

# Make Flux-Insight importable in-process so the Claim-Chain can be read directly
# (ClaimChainAPI facade is stubbed; use the real ClaimChainV2 in claim_chain.chain).
_FI_ROOT = os.environ.get("FLUX_FI_ROOT", "")
if _FI_ROOT and _FI_ROOT not in sys.path:
    sys.path.insert(0, _FI_ROOT)

# FLUXmeme SDK (.flux DevReady assets) — sibling of FluxWorkbench under ARIS.
_FLUXMEMO_PY = os.environ.get(
    "FLUXMEMO_PY", str(Path(__file__).resolve().parents[4] / "FLUXMEMO" / "python")
)
if _FLUXMEMO_PY and Path(_FLUXMEMO_PY).is_dir() and _FLUXMEMO_PY not in sys.path:
    sys.path.insert(0, _FLUXMEMO_PY)

UI_DIR = Path(__file__).resolve().parents[2] / "ui"

app = FastAPI(title="Flux Workbench runtime")
coord: Coordinator = Coordinator()
_subscribers: set[WebSocket] = set()
_log: deque = deque(maxlen=500)


async def _register(sa) -> None:
    coord.register(sa)
    try:
        await sa.start()
    except Exception as e:  # a backend failing to spawn must not kill the server
        print(f"[flux] {sa.id} start failed: {e!r}", flush=True)


@app.on_event("startup")
async def _startup() -> None:
    # Two mock targets — the guideline §15 dual-debugger scenario, no hardware.
    await _register(MockOpenOCDSubagent("hpm-0", target="hpm", gdb_port=3333))
    await _register(MockOpenOCDSubagent("stm32-0", target="stm32", gdb_port=3334))
    # Backend engines plug into the Flux shell (opt-in via env). Flux is host;
    # Flux-Insight is the research brain, openwork is the agent-cowork engine.
    fi_root = os.environ.get("FLUX_FI_ROOT")
    if fi_root:
        await _register(FluxInsightSubagent(
            "flux-insight", fi_root=fi_root,
            python_exe=os.environ.get("FLUX_FI_PYTHON", sys.executable),
            workspace=os.environ.get("FLUX_FI_WORKSPACE", fi_root),
        ))
    ow_root = os.environ.get("FLUX_OPENWORK_ROOT")
    if ow_root:
        await _register(OpenWorkSubagent(
            "openwork", openwork_root=ow_root,
            workspace=os.environ.get("FLUX_OPENWORK_WORKSPACE", "."),
        ))


@app.get("/api/subagents")
async def list_subagents() -> list[dict[str, Any]]:
    out = []
    for sa in coord._subs.values():
        out.append({
            "id": sa.id,
            "kind": type(sa).__name__,
            "target": getattr(sa, "target", ""),
            "gdb_port": getattr(sa, "gdb_port", None),
            "capabilities": list(sa.capabilities),
        })
    return out


@app.post("/api/dispatch")
async def dispatch(target: str, op: str, args: str = "") -> list[dict[str, Any]]:
    parsed: list[Any] = []
    for a in (x.strip() for x in args.split(",") if x.strip()):
        try:
            parsed.append(int(a, 0))  # 0x.. / decimal
        except ValueError:
            parsed.append(a)
    msg = Message(target=target, op=op, args=tuple(parsed))
    trace = await coord.dispatch(msg)
    emitted = []
    for e in trace:
        await _broadcast(e)
        emitted.append({"source": e.source, "kind": e.kind, "data": e.data, "trace_id": e.trace_id})
    # measurement → .flux DevReady asset. Execute half is pure hardware: NO FI.
    # Writes BODY device-comm (device topology) + JOURNAL signal (measurement).
    try:
        from fluxmeme import Store as _FStore, Record as _FRec, LAYER_BODY, LAYER_JOURNAL
        with _FStore(str(_flux_store_path()), writable=True) as st:
            with st.write() as txn:
                # BODY: device-comm node — the device's topology record
                st.put(txn, _FRec(
                    layer=LAYER_BODY, kind="device-comm/node",
                    ptype="application/json",
                    meta={"device": target,
                          "protocol": getattr(coord._subs.get(target), "target", "unknown"),
                          "gdb_port": getattr(coord._subs.get(target), "gdb_port", None)},
                    payload=json.dumps({"target": target, "last_op": op}).encode(),
                ))
                # JOURNAL: the measurement signal
                st.put(txn, _FRec(
                    layer=LAYER_JOURNAL, kind="signal", ptype="text/markdown",
                    meta={"source": target, "op": op},
                    payload=json.dumps(
                        [{"kind": e.kind, "data": e.data} for e in trace],
                        ensure_ascii=False,
                    ).encode(),
                ))
    except Exception:
        pass  # asset write is best-effort; never block a dispatch
    return emitted


def _find_cc_db() -> Path | None:
    """Locate a Claim-Chain cc.db: configured workspace first, else the most
    recent Flux-Insight session under FLUX_FI_ROOT/sessions/*/_index/."""
    candidates: list[Path] = []
    ws = os.environ.get("FLUX_FI_WORKSPACE")
    if ws:
        candidates.append(Path(ws) / "_index" / "cc.db")
    if _FI_ROOT:
        sess = Path(_FI_ROOT) / "sessions"
        if sess.is_dir():
            kids = sorted(
                [d for d in sess.iterdir() if d.is_dir()],
                key=lambda p: p.stat().st_mtime, reverse=True,
            )
            for d in kids:
                candidates.append(d / "_index" / "cc.db")
    for c in candidates:
        if c.exists():
            return c
    return None


def _flux_store_path() -> Path:
    """Flux Workbench's OWN DevReady asset store (.flux) — bench measurements
    persist here as JOURNAL signals. Decoupled from Flux-Insight's Claim-Chain
    (research) so the execute half stays pure hardware, no FI."""
    default = Path(__file__).resolve().parents[2] / ".fluxws"
    ws = Path(os.environ.get("FLUX_WORKSPACE", default))
    ws.mkdir(parents=True, exist_ok=True)
    return ws / "assets.flux"


def _atom_json(a) -> dict:
    if not isinstance(a, dict):
        a = {k: getattr(a, k, None) for k in ("id", "type", "title", "content", "tags")}
    return {k: a.get(k) for k in ("id", "type", "title", "content", "tags")}


@app.get("/api/claims")
async def claims(q: str = "", limit: int = 50) -> dict:
    """Flux-Insight Claim-Chain — the RESEARCH half only (grounding). FI lives
    here; the execute half never touches this."""
    db = _find_cc_db()
    if not db:
        return {"error": "no cc.db (set FLUX_FI_ROOT / FLUX_FI_WORKSPACE or run Flux-Insight)"}
    try:
        from claim_chain.chain import ClaimChainV2
        ch = ClaimChainV2(db)
        summary = ch.get_graph_summary()
        atoms = [_atom_json(a) for a in ch.get_atoms(limit=max(limit, 50))]
        ch.close()
        if q:
            ql = q.lower()
            atoms = [a for a in atoms if ql in f"{a.get('title','')} {a.get('content','')} {a.get('type','')}".lower()]
        return {"db": str(db), "summary": summary, "atoms": atoms[:limit]}
    except Exception as e:
        return {"error": repr(e)}


@app.get("/api/assets")
async def assets(limit: int = 50) -> dict:
    """DevReady .flux assets — BODY (device topology) + MIND (driver/skills) +
    JOURNAL (measurements). The Asset pillar's read surface."""
    sp = _flux_store_path()
    if not sp.exists():
        return {"store": str(sp), "count": 0, "layers": {}, "records": [], "note": "dispatch a measurement first"}
    try:
        from fluxmeme import Store
        out = []
        layers = {"BODY": 0, "MIND": 0, "JOURNAL": 0}
        with Store(str(sp), writable=False) as st:
            with st.read() as txn:
                for r in st.scan(txn):
                    lname = {1: "BODY", 2: "MIND", 4: "JOURNAL"}.get(r.layer, f"L{r.layer}")
                    layers[lname] = layers.get(lname, 0) + 1
                    out.append({"id": r.id, "layer": lname, "kind": r.kind,
                                "meta": r.meta})
                    if len(out) >= limit:
                        break
        return {"store": str(sp), "count": len(out), "layers": layers, "records": out}
    except Exception as e:
        return {"error": repr(e)}


@app.get("/api/assets/export")
async def export_assets(fmt: str = "usd"):
    """Export .flux to a standard format via FLUXmeme transcoders:
    usd (BODY → USDA scene), mcap (JOURNAL → rosbag), okf (MIND → markdown)."""
    from fastapi.responses import FileResponse as _FR
    sp = _flux_store_path()
    if not sp.exists():
        return {"error": "no store"}
    ext = {"usd": "usda", "mcap": "mcap", "okf": "md"}.get(fmt, "bin")
    out = sp.parent / f"export.{ext}"
    try:
        from fluxmeme import Store
        with Store(str(sp), writable=False) as st:
            with st.read() as txn:
                if fmt == "usd":
                    st.to_usd(txn, str(out))
                elif fmt == "mcap":
                    st.to_mcap(txn, str(out))
                elif fmt == "okf":
                    st.to_okf(txn, str(out))
                else:
                    return {"error": f"unknown format {fmt}"}
        return _FR(str(out), filename=f"flux-export.{ext}")
    except Exception as e:
        return {"error": repr(e)}


@app.post("/api/assets/ingest_urdf")
async def ingest_urdf(path: str) -> dict:
    """Ingest a URDF robot description → .flux BODY records (FLUXmeme from_urdf).
    This is the FluxWeave bridge: FluxWeave produces URDF → from_urdf → .flux."""
    sp = _flux_store_path()
    try:
        from fluxmeme import Store
        with Store(str(sp), writable=True) as st:
            with st.write() as txn:
                st.from_urdf(txn, path)
        return {"status": "ok", "urdf": path, "store": str(sp)}
    except Exception as e:
        return {"error": repr(e)}


@app.post("/api/sim")
async def simulate(asset_ref: str = "", action: str = "",
                   torque_mnm: float = 0.0, steps: int = 2000) -> dict:
    """World pillar: REAL mechanical dynamics via NVIDIA Warp (rigid-rotor).

    predict-before-act: given a torque command, integrates J·dω/dt = τ − b·ω
    (semi-implicit Euler, GPU-ready via Warp kernel) and returns the RPM
    trajectory. This replaces the mock with a genuine first-principles solver.

    Currently single-DOF rotary (motor/gearbox); multi-body articulations
    and FLUXVortex (aero) / FluxPhased (EM) are later additions.
    """
    from .world.warp_solver import SOLVER
    return SOLVER.predict(torque_mnm=torque_mnm if torque_mnm else 50.0,
                          steps=steps, rpm0=0.0)


@app.websocket("/ws/events")
async def ws_events(ws: WebSocket) -> None:
    await ws.accept()
    _subscribers.add(ws)
    try:
        for e in list(_log):  # replay recent
            await ws.send_text(_pack(e))
        while True:
            await ws.receive_text()  # keep-alive; inbound ignored
    except WebSocketDisconnect:
        pass
    finally:
        _subscribers.discard(ws)


async def _broadcast(e: Event) -> None:
    _log.append(e)
    payload = _pack(e)
    dead = []
    for ws in list(_subscribers):
        try:
            await ws.send_text(payload)
        except Exception:
            dead.append(ws)
    for ws in dead:
        _subscribers.discard(ws)


def _pack(e: Event) -> str:
    return json.dumps({"source": e.source, "kind": e.kind, "data": e.data, "trace_id": e.trace_id})


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(UI_DIR / "index.html")


app.mount("/ui", StaticFiles(directory=str(UI_DIR)), name="ui")
