"""Multi-provider LLM client — supports vLLM (local), OpenAI-compatible, Anthropic.

Configured via env vars or the studio's API Config panel (cmd.set_api event):
  FLUX_LLM_PROVIDER = vllm | openai | anthropic
  FLUX_LLM_ENDPOINT = http://127.0.0.1:8000 (vllm) or https://api.openai.com/v1 (openai)
  FLUX_LLM_API_KEY  = sk-... (for openai/anthropic)
  FLUX_LLM_MODEL    = openbmb/MiniCPM-V-4.6 (vllm) or gpt-4o (openai) or claude-sonnet-4-5-20250929 (anthropic)

The brain uses this for chat + characterize. If the provider is unavailable,
falls back to mock.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any

log = logging.getLogger("flux_brain.llm")

# MiniCPM-V 4.6 stop tokens (Qwen3.5 vocab EOS)
_STOP_TOKEN_IDS = [248044, 248046]

# Runtime config (mutable — updated by cmd.set_api events)
_config: dict[str, str] = {
    "provider": os.environ.get("FLUX_LLM_PROVIDER", "vllm"),
    "endpoint": os.environ.get("FLUX_LLM_ENDPOINT", "http://127.0.0.1:8000"),
    "api_key":  os.environ.get("FLUX_LLM_API_KEY", ""),
    "model":    os.environ.get("FLUX_LLM_MODEL", "openbmb/MiniCPM-V-4.6"),
}


def update_config(**kwargs: str) -> None:
    """Update the LLM config at runtime (called from cmd.set_api handler)."""
    _config.update(kwargs)
    log.info("LLM config updated: provider=%s model=%s endpoint=%s",
             _config["provider"], _config["model"], _config["endpoint"])


def get_config() -> dict[str, str]:
    return dict(_config)


def chat(prompt: str) -> str:
    """Send a chat prompt to the configured provider. Returns the reply text."""
    provider = _config["provider"]
    try:
        if provider == "vllm":
            return _chat_vllm(prompt)
        elif provider == "openai":
            return _chat_openai(prompt)
        elif provider == "anthropic":
            return _chat_anthropic(prompt)
        else:
            return f"(unknown provider: {provider})"
    except Exception as e:  # noqa: BLE001
        log.warning("LLM chat failed (%s): %s", provider, e)
        return f"(LLM unavailable — {provider}: {e})"


def _get_model_id() -> str:
    """For vLLM, discover the served model ID; for others, use configured."""
    if _config["provider"] == "vllm":
        try:
            import httpx
            resp = httpx.get(f"{_config['endpoint']}/v1/models", timeout=5)
            models = resp.json().get("data", [])
            if models:
                return models[0]["id"]
        except Exception:
            pass
    return _config["model"]


def _chat_vllm(prompt: str) -> str:
    import httpx
    model = _get_model_id()
    resp = httpx.post(
        f"{_config['endpoint']}/v1/chat/completions",
        json={
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "stop_token_ids": _STOP_TOKEN_IDS,
            "temperature": 0,
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _chat_openai(prompt: str) -> str:
    import httpx
    resp = httpx.post(
        f"{_config['endpoint']}/chat/completions",
        headers={"Authorization": f"Bearer {_config['api_key']}"},
        json={
            "model": _config["model"],
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()["choices"][0]["message"]["content"]


def _chat_anthropic(prompt: str) -> str:
    import httpx
    resp = httpx.post(
        "https://api.anthropic.com/v1/messages",
        headers={
            "x-api-key": _config["api_key"],
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
        },
        json={
            "model": _config["model"],
            "max_tokens": 1024,
            "messages": [{"role": "user", "content": prompt}],
        },
        timeout=30,
    )
    resp.raise_for_status()
    data = resp.json()
    # Anthropic returns content as a list of blocks
    for block in data.get("content", []):
        if block.get("type") == "text":
            return block["text"]
    return "(no text in response)"


def characterize() -> dict[str, Any]:
    """Characterize HPM6E00 via the configured provider."""
    prompt = (
        "You are a hardware engineer. Characterize the HPM6E00 MCU concisely.\n"
        "Return STRICT JSON only with this schema:\n"
        '{"chip":"HPM6E0","core":"...","peripherals":["GPIO","UART",...],'
        '"memory_map":{"flash":"0x...","ram":"0x...","size":"..."},'
        '"driver_skeleton":{"language":"c","init":"...","notes":"..."},'
        '"bench":{"method":"gpio-toggle","status":"stub"}}\n'
        "Return ONLY the JSON object."
    )
    raw = chat(prompt)
    raw = raw.strip()
    if raw.startswith("```"):
        raw = raw.strip("`")
        if raw.lower().startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return {"raw": raw, "chip": "HPM6E0", "peripherals": ["GPIO", "SPI", "CAN"], "parse_error": True}
