#!/usr/bin/env python3
"""Standalone CLI: schematic image -> netlist via MiniCPM-V 4.6 (vLLM).

Usage: PYTHONPATH=brain <venv>/python spike/schematic-to-netlist.py [image.png]
Defaults to spike/schematic/test_schematic.png. Prints the extracted netlist JSON.
Requires a running vLLM server: vllm serve openbmb/MiniCPM-V-4.6 --port 8000
"""
import json
import sys
from pathlib import Path

# allow running from repo root with PYTHONPATH=brain
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "brain"))

from flux_brain.llm_vllm import schematic_to_netlist  # noqa: E402

img = sys.argv[1] if len(sys.argv) > 1 else "spike/schematic/test_schematic.png"
print(f"[schematic→netlist] image: {img}", file=sys.stderr)
netlist = schematic_to_netlist(img)
print(json.dumps(netlist, ensure_ascii=False, indent=2))
