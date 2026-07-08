"""Policy gate — pain point ⑤ (自主持续运行，少批准).

The agent runs autonomously within capability/policy bounds. Sensitive operations
(erase, high-voltage, external-send) require approval; everything else auto-allowed.
This replaces the "always-asking-for-approval" pattern with a declarative policy.
"""
from __future__ import annotations

from typing import Any, Literal

Decision = Literal["allow", "approve", "deny"]

# Operations that need human approval before execution (pain point ⑤).
SENSITIVE_OPS: set[str] = {
    "flash.erase",       # erasing flash — destructive
    "otaprogram",        # OTA programming — external send
    "external.send",     # sending data externally
    "high.voltage",      # high-voltage operations
    "secure.erase",      # secure erase — irreversible
}

# Operations that are flat-out denied (never auto-approve).
DENIED_OPS: set[str] = {
    "firmware.brick",    # never brick firmware
}


def check(op: str, ctx: dict[str, Any] | None = None) -> Decision:
    """Check if an operation is allowed, needs approval, or is denied.

    - "allow": proceed autonomously (no human needed)
    - "approve": sensitive op, needs human confirmation
    - "deny": never allowed
    """
    if op in DENIED_OPS:
        return "deny"
    if op in SENSITIVE_OPS:
        return "approve"
    return "allow"
