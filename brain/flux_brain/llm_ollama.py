"""Ollama-backed local LLM client for the brain (MiniCPM-V via Ollama, OpenAI-compat).

Pain point ②: schematic understanding ≠ OCR. MiniCPM-V (multimodal) reads a
schematic image and returns structured netlist + components + signals. No
external API key — runs locally on the GPU (once the driver + Ollama + minicpm-v
are up).

Usage:
    from flux_brain.llm_ollama import schematic_to_netlist
    netlist = schematic_to_netlist("schematic.png", model="minicpm-v")
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

log = logging.getLogger("flux_brain.llm_ollama")

OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "http://127.0.0.1:11434")
# MiniCPM-V 4.6 (OpenBMB, 2026.05): 1.3B (SigLIP2-400M + Qwen3.5-0.8B), edge multimodal.
DEFAULT_VISION_MODEL = os.environ.get("FLUX_VISION_MODEL", "openbmb/minicpm-v4.6")
DEFAULT_TEXT_MODEL = os.environ.get("FLUX_TEXT_MODEL", "openbmb/minicpm-v4.6")

SCHEMATIC_PROMPT = """\
You are a hardware engineer analyzing an electronic schematic image.
Extract the circuit structure and return STRICT JSON only (no prose, no markdown fences) with this schema:
{
  "components": [{"refdes": "R1", "type": "resistor", "value": "10k", "pins": ["1","2"]}, ...],
  "nets": [{"name": "NET_VCC", "nodes": [{"refdes":"R1","pin":"1"}, ...]}, ...],
  "signals": ["power","digital_io","analog", ...],
  "notes": "any uncertainty or non-OCR-derived inference"
}
Identify components by their reference designators and pin numbers. Group
connected pins into nets. This must be structural understanding, NOT OCR of text.
Return only the JSON object."""


def _client():
    import ollama  # imported lazily so the module loads without ollama installed

    return ollama.Client(host=OLLAMA_HOST)


def chat(prompt: str, *, model: str | None = None) -> str:
    """Plain text chat."""
    model = model or DEFAULT_TEXT_MODEL
    resp = _client().chat(model=model, messages=[{"role": "user", "content": prompt}])
    return resp["message"]["content"] if isinstance(resp, dict) else resp.message.content


def vision(prompt: str, image_path: str, *, model: str | None = None) -> str:
    """Multimodal: send an image + prompt, return text."""
    model = model or DEFAULT_VISION_MODEL
    p = Path(image_path)
    if not p.is_file():
        raise FileNotFoundError(image_path)
    images = [str(p)]
    resp = _client().chat(
        model=model,
        messages=[{"role": "user", "content": prompt, "images": images}],
    )
    return resp["message"]["content"] if isinstance(resp, dict) else resp.message.content


def schematic_to_netlist(image_path: str, *, model: str | None = None) -> dict[str, Any]:
    """Pain point ②: schematic image -> structured netlist (MiniCPM-V multimodal).

    Returns the parsed JSON dict. Raises ValueError if the model didn't return
    parseable JSON (falls back to wrapping raw text under "raw").
    """
    raw = vision(SCHEMATIC_PROMPT, image_path, model=model)
    raw = raw.strip()
    # tolerate markdown fences if the model wrapped output despite instructions
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        log.warning("minicpm-v did not return clean JSON; wrapping raw text")
        return {"raw": raw, "parse_error": True}
