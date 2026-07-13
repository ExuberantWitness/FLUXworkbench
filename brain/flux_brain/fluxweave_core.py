"""FluxWeave headless core — URDF generation without Qt/VTK/NodeGraphQt.

Ported from vendor/integrations/FluxWeave/FluxhWeave_Assembler_V3.py (the
active V3 assembler): the node-graph objects are replaced by plain dataclasses,
the joint-transform math and URDF writer are kept verbatim in behavior.
STL-embedded metadata I/O is reused directly from the vendored stl_metadata.py
(pure stdlib). Dependencies: numpy + stdlib only.
"""
from __future__ import annotations

import math
import os
import shutil
import sys
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np

_FLUXWEAVE_DIR = Path(__file__).resolve().parents[2] / "vendor" / "integrations" / "FluxWeave"
if str(_FLUXWEAVE_DIR) not in sys.path:
    sys.path.insert(0, str(_FLUXWEAVE_DIR))

import stl_metadata  # noqa: E402  (pure stdlib module from the vendored repo)

read_metadata = stl_metadata.extract_metadata_text
embed_metadata = stl_metadata.write_embedded_metadata
strip_metadata = stl_metadata.strip_metadata_text


# ── specs (replace PartNode / ConnectorNode) ─────────────────────────────────

@dataclass
class PartSpec:
    id: str
    link_name: str
    stl_file: str = ""
    origin_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    origin_rpy: tuple[float, float, float] = (0.0, 0.0, 0.0)
    color_rgba: tuple[float, float, float, float] = (1.0, 1.0, 1.0, 1.0)


@dataclass
class ConnectorSpec:
    parent_id: str
    child_id: str
    parent_axis: tuple[float, float, float] = (1.0, 0.0, 0.0)
    child_axis: tuple[float, float, float] = (1.0, 0.0, 0.0)
    parent_local_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    child_local_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    offset_xyz: tuple[float, float, float] = (0.0, 0.0, 0.0)
    offset_rpy: tuple[float, float, float] = (0.0, 0.0, 0.0)
    joint_type: str = "revolute"
    joint_name: str = ""
    joint_angle: float = 0.0
    joint_limit_lower: float = -math.pi
    joint_limit_upper: float = math.pi
    joint_effort: float = 0.0
    joint_velocity: float = 0.0


@dataclass
class GraphSpec:
    base_link: str = "base_link"
    robot_name: str = "fluxweave_robot"
    parts: list[PartSpec] = field(default_factory=list)
    connectors: list[ConnectorSpec] = field(default_factory=list)

    @staticmethod
    def from_dict(d: dict[str, Any]) -> "GraphSpec":
        return GraphSpec(
            base_link=d.get("base_link", "base_link"),
            robot_name=d.get("robot_name", "fluxweave_robot"),
            parts=[PartSpec(**{**p, "origin_xyz": tuple(p.get("origin_xyz", (0, 0, 0))),
                               "origin_rpy": tuple(p.get("origin_rpy", (0, 0, 0))),
                               "color_rgba": tuple(p.get("color_rgba", (1, 1, 1, 1)))})
                   for p in d.get("parts", [])],
            connectors=[ConnectorSpec(**c) for c in d.get("connectors", [])],
        )


# ── pure math (ported from AssemblerGraphV3 staticmethods) ──────────────────

def _normalize(vec) -> np.ndarray:
    arr = np.array(vec, dtype=float)
    n = np.linalg.norm(arr)
    return arr / n if n >= 1e-9 else np.zeros(3)


def _skew(vec) -> np.ndarray:
    x, y, z = vec
    return np.array([[0, -z, y], [z, 0, -x], [-y, x, 0]])


def _orthogonal_axis(vec) -> np.ndarray:
    x, y, z = vec
    if abs(x) < abs(y) and abs(x) < abs(z):
        ortho = np.array([0, -z, y])
    elif abs(y) < abs(z):
        ortho = np.array([-z, 0, x])
    else:
        ortho = np.array([-y, x, 0])
    return _normalize(ortho)


def _rotation_about(axis, angle) -> np.ndarray:
    a = _normalize(axis)
    if np.linalg.norm(a) < 1e-9:
        return np.identity(3)
    x, y, z = a
    c, s = math.cos(angle), math.sin(angle)
    C = 1 - c
    return np.array([
        [c + x * x * C, x * y * C - z * s, x * z * C + y * s],
        [y * x * C + z * s, c + y * y * C, y * z * C - x * s],
        [z * x * C - y * s, z * y * C + x * s, c + z * z * C],
    ])


def _rotation_between(source, target) -> np.ndarray:
    s, t = _normalize(source), _normalize(target)
    if np.linalg.norm(s) < 1e-9 or np.linalg.norm(t) < 1e-9:
        return np.identity(3)
    v = np.cross(s, t)
    c = np.clip(np.dot(s, t), -1.0, 1.0)
    k = np.linalg.norm(v)
    if k < 1e-9:
        return np.identity(3) if c > 0 else _rotation_about(_orthogonal_axis(s), math.pi)
    vx = _skew(v / k)
    return np.identity(3) + vx + vx @ vx * ((1 - c) / (k * k))


def matrix_from_xyz_rpy(xyz, rpy) -> np.ndarray:
    roll, pitch, yaw = rpy
    rx = _rotation_about((1, 0, 0), roll)
    ry = _rotation_about((0, 1, 0), pitch)
    rz = _rotation_about((0, 0, 1), yaw)
    m = np.identity(4)
    m[:3, :3] = rz @ ry @ rx
    m[:3, 3] = xyz
    return m


def matrix_to_rpy(rotation: np.ndarray) -> tuple[float, float, float]:
    sy = -rotation[2, 0]
    cy = math.sqrt(max(0.0, 1.0 - sy * sy))
    if cy < 1e-9:
        roll = math.atan2(-rotation[0, 1], rotation[1, 1])
        pitch = math.pi / 2 if sy > 0 else -math.pi / 2
        yaw = 0.0
    else:
        roll = math.atan2(rotation[2, 1], rotation[2, 2])
        pitch = math.asin(sy)
        yaw = math.atan2(rotation[1, 0], rotation[0, 0])
    return roll, pitch, yaw


def compute_joint_transform(conn: ConnectorSpec, angle: float | None = None) -> np.ndarray:
    """Parent→child link transform (ported from _compute_relative_matrix)."""
    parent_axis = _normalize(conn.parent_axis)
    child_axis = _normalize(conn.child_axis)
    if np.linalg.norm(parent_axis) < 1e-9:
        parent_axis = np.array([1.0, 0.0, 0.0])
    if np.linalg.norm(child_axis) < 1e-9:
        child_axis = parent_axis
    align = _rotation_between(child_axis, parent_axis)
    rot = _rotation_about(parent_axis, conn.joint_angle if angle is None else angle) @ align
    translation = np.array(conn.parent_local_xyz) - rot @ np.array(conn.child_local_xyz)
    base = np.identity(4)
    base[:3, :3] = rot
    base[:3, 3] = translation
    return base @ matrix_from_xyz_rpy(conn.offset_xyz, conn.offset_rpy)


# ── metadata parsing (ported from _parse_metadata_xml, Qt-free) ─────────────

def parse_metadata_xml(xml_text: str) -> dict[str, Any]:
    root = ET.fromstring(xml_text)
    if root.tag != "urdf_part":
        raise ValueError(f"unexpected metadata root: {root.tag}")
    link = root.find("link")
    out: dict[str, Any] = {
        "link_name": link.get("name", "unnamed_link") if link is not None else "unnamed_link",
        "origin_xyz": (0.0, 0.0, 0.0), "origin_rpy": (0.0, 0.0, 0.0),
        "color_rgba": (1.0, 1.0, 1.0, 1.0), "points": [],
    }
    if link is not None and (o := link.find("origin")) is not None:
        out["origin_xyz"] = tuple(float(v) for v in o.get("xyz", "0 0 0").split())
        out["origin_rpy"] = tuple(float(v) for v in o.get("rpy", "0 0 0").split())
    if (m := root.find("material")) is not None and (c := m.find("color")) is not None:
        rgba = c.get("rgba", "1 1 1 1").split()
        if len(rgba) == 4:
            out["color_rgba"] = tuple(float(v) for v in rgba)
    for idx, p in enumerate(root.findall("point")):
        xyz_el, axis_el = p.find("point_xyz"), p.find("joint_axis")
        out["points"].append({
            "index": idx, "name": p.get("name", f"point{idx + 1}"),
            "position": tuple(float(v) for v in xyz_el.text.strip().split()) if xyz_el is not None and xyz_el.text else (0.0, 0.0, 0.0),
            "axis": tuple(float(v) for v in axis_el.get("xyz", "1 0 0").split()) if axis_el is not None else (1.0, 0.0, 0.0),
        })
    return out


# ── URDF generation (ported from build_urdf_text) ───────────────────────────

def generate_urdf(graph: GraphSpec, mesh_path_prefix: str = "meshes/",
                  mesh_name_map: dict[str, str] | None = None) -> str:
    link_names = {p.id: p.link_name or p.id for p in graph.parts}
    base_id = "__base__"
    link_names[base_id] = graph.base_link

    lines = ['<?xml version="1.0"?>', f'<robot name="{graph.robot_name}">',
             f'  <link name="{graph.base_link}"/>']

    for part in graph.parts:
        mesh_file = os.path.basename(part.stl_file) if part.stl_file else ""
        if mesh_name_map and part.id in mesh_name_map:
            mesh_file = mesh_name_map[part.id]
        mesh_ref = f"{mesh_path_prefix}{mesh_file}" if mesh_file else ""
        oxyz = " ".join(f"{v:.6f}" for v in part.origin_xyz)
        orpy = " ".join(f"{v:.6f}" for v in part.origin_rpy)
        rgba = " ".join(f"{v:.3f}" for v in part.color_rgba)
        name = link_names[part.id]
        lines += [
            f'  <link name="{name}">',
            "    <visual>",
            f'      <origin xyz="{oxyz}" rpy="{orpy}"/>',
            "      <geometry>",
            f'        <mesh filename="{mesh_ref}"/>',
            "      </geometry>",
            f'      <material name="{name}_mat">',
            f'        <color rgba="{rgba}"/>',
            "      </material>",
            "    </visual>",
            "    <collision>",
            f'      <origin xyz="{oxyz}" rpy="{orpy}"/>',
            "      <geometry>",
            f'        <mesh filename="{mesh_ref}"/>',
            "      </geometry>",
            "    </collision>",
            "  </link>",
        ]

    # BFS over connectors from base (same traversal as the V3 assembler)
    queue = [base_id]
    visited: set[int] = set()
    while queue:
        parent_id = queue.pop(0)
        for i, conn in enumerate(graph.connectors):
            if i in visited or conn.parent_id != parent_id or not conn.child_id:
                continue
            visited.add(i)
            queue.append(conn.child_id)

            zero = compute_joint_transform(conn, angle=0.0)
            oxyz = " ".join(f"{v:.6f}" for v in zero[:3, 3])
            orpy = " ".join(f"{v:.6f}" for v in matrix_to_rpy(zero[:3, :3]))
            axis = _normalize(conn.parent_axis)
            if np.linalg.norm(axis) < 1e-9:
                axis = np.array([1.0, 0.0, 0.0])
            jname = conn.joint_name or f"joint_{link_names.get(conn.child_id, 'child')}"
            lines += [
                f'  <joint name="{jname}" type="{conn.joint_type}">',
                f'    <parent link="{link_names.get(conn.parent_id, graph.base_link)}"/>',
                f'    <child link="{link_names.get(conn.child_id, conn.child_id)}"/>',
                f'    <origin xyz="{oxyz}" rpy="{orpy}"/>',
                f'    <axis xyz="{" ".join(f"{v:.6f}" for v in axis)}"/>',
            ]
            effort = max(0.0, conn.joint_effort)
            velocity = max(0.0, conn.joint_velocity)
            if conn.joint_type in ("revolute", "prismatic"):
                lines.append(
                    f'    <limit lower="{conn.joint_limit_lower:.6f}" upper="{conn.joint_limit_upper:.6f}" '
                    f'effort="{effort:.6f}" velocity="{velocity:.6f}"/>')
            elif conn.joint_type == "continuous":
                lines.append(f'    <limit effort="{effort:.6f}" velocity="{velocity:.6f}"/>')
            lines.append("  </joint>")

    lines.append("</robot>")
    return "\n".join(lines)


def export_urdf_project(graph: GraphSpec, out_dir: str,
                        mesh_path_prefix: str = "meshes/") -> dict[str, Any]:
    """Write <out_dir>/<robot>.urdf and copy part meshes (from _on_save_urdf)."""
    out = Path(out_dir)
    (out / mesh_path_prefix).mkdir(parents=True, exist_ok=True)
    name_map: dict[str, str] = {}
    used: set[str] = set()
    for part in graph.parts:
        if not part.stl_file or not Path(part.stl_file).is_file():
            continue
        base = os.path.basename(part.stl_file)
        candidate, n = base, 1
        while candidate in used:
            stem, ext = os.path.splitext(base)
            candidate = f"{stem}_{n}{ext}"
            n += 1
        used.add(candidate)
        name_map[part.id] = candidate
        shutil.copy2(part.stl_file, out / mesh_path_prefix / candidate)
    urdf = generate_urdf(graph, mesh_path_prefix, name_map)
    urdf_path = out / f"{graph.robot_name}.urdf"
    urdf_path.write_text(urdf)
    return {"urdf_path": str(urdf_path), "meshes_copied": len(name_map)}
