"""vLLM OpenAI-compatible client for MiniCPM-V 4.6 (local, GPU).

Replaces the Ollama path (Ollama's multimodal support is weaker). vLLM v0.22+
serves MiniCPM-V 4.6 natively at http://127.0.0.1:8000/v1/chat/completions
(multimodal: messages[].content[] with {"type":"image_url","image_url":{"url":...}}).

Start the server (build-task): vllm serve <model> --port 8000 [flags]
"""
from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
from pathlib import Path
from typing import Any

from flux_brain.llm_ollama import SCHEMATIC_PROMPT  # reuse the extraction prompt

log = logging.getLogger("flux_brain.llm_vllm")

VLLM_HOST = os.environ.get("VLLM_HOST", "http://127.0.0.1:8000")
DEFAULT_MODEL = os.environ.get("FLUX_VISION_MODEL", "openbmb/MiniCPM-V-4.6")
# MiniCPM-V 4.6 uses Qwen3.5 vocab; these are the correct EOS token IDs (NOT v4.5's [1,151645]).
STOP_TOKEN_IDS = [248044, 248046]


def _post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    import httpx

    r = httpx.post(f"{VLLM_HOST}{path}", json=payload, timeout=300.0)
    r.raise_for_status()
    return r.json()


def chat(prompt: str, *, model: str | None = None) -> str:
    resp = _post("/v1/chat/completions", {
        "model": model or DEFAULT_MODEL,
        "messages": [{"role": "user", "content": prompt}],
        "stop_token_ids": STOP_TOKEN_IDS,
    })
    return resp["choices"][0]["message"]["content"]


def _data_url(image_path: str) -> str:
    p = Path(image_path)
    if not p.is_file():
        raise FileNotFoundError(image_path)
    mime = mimetypes.guess_type(image_path)[0] or "image/png"
    b64 = base64.b64encode(p.read_bytes()).decode("ascii")
    return f"data:{mime};base64,{b64}"


def vision(prompt: str, image_path: str, *, model: str | None = None) -> str:
    resp = _post("/v1/chat/completions", {
        "model": model or DEFAULT_MODEL,
        "messages": [{
            "role": "user",
            "content": [
                {"type": "text", "text": prompt},
                {"type": "image_url", "image_url": {"url": _data_url(image_path)}},
            ],
        }],
        "stop_token_ids": STOP_TOKEN_IDS,
    })
    return resp["choices"][0]["message"]["content"]


def schematic_to_netlist(image_path: str, *, model: str | None = None) -> dict[str, Any]:
    """Pain point ②: schematic image -> structured netlist via MiniCPM-V 4.6."""
    raw = vision(SCHEMATIC_PROMPT, image_path, model=model).strip()
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
