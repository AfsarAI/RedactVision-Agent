"""
RedactVision Agent — Server-side LLM Planner

Phase 7 / Phase 9+: Multi-Provider Fallback & Retry Loop.

All API keys are read from environment variables. None are hard-coded.
See .env.example for required variables.

Privacy contract (CLAUDE.md invariants):
  - This module ONLY ever receives sanitized DOM (tokens like [EMAIL_01]).
  - It NEVER receives the local token map.
  - It returns a structured action; the client validates and executes.

Priority chain (see multi_provider_llm.py):
  1. Gemini  →  2. Groq  →  3. OpenRouter  →  4. NVIDIA NIM
  →  5. OmniRoute  →  6. Hugging Face

On any failure (429 / 500 / 503 / timeout / unavailable) the loop
automatically backs off and tries the next provider. The loop is
infinite — it only exits with a successful response or after 200
internal attempts (configurable via LLM_MAX_ATTEMPTS).

Existing exports preserved (backward-compatible):
  plan_with_llm()   — main entry for the /llm/plan endpoint
  health()          — /llm/health status dict
  is_configured()   — True if at least one provider has a key
  validate_action_shape()  — JSON schema validation
  _parse_json()     — JSON extraction from model output
"""

from __future__ import annotations

import json
import logging
import os
import re
from typing import Any, Optional

import httpx

from .planner_prompt import SYSTEM_PROMPT, build_user_prompt
from .types import SanitizedEvent
from .multi_provider_llm import MultiProviderLLM, generate_llm_response as _generate_llm_response

logger = logging.getLogger("redactvision_server.llm")

# ----- Module-level singleton (lazy) -----
_llm: Optional[MultiProviderLLM] = None


def _get_llm() -> MultiProviderLLM:
    global _llm
    if _llm is None:
        _llm = MultiProviderLLM()
    return _llm


# ----- Config helpers -----

def _read_env_or_default(key: str, default: str) -> str:
    return os.environ.get(key, default)


DEFAULT_MODEL = "llama-3.1-8b-instant"
MAX_TOKENS = 400
TEMPERATURE = 0.1
REQUEST_TIMEOUT = 30.0


# ----- Provider availability helpers (used by health) -----

def _available_providers() -> list[dict]:
    """Return a list of provider status dicts for the /llm/health endpoint."""
    from .providers import PROVIDERS
    return [
        {"name": p.name, "available": p.available()}
        for p in PROVIDERS
    ]


# ----- Public API (backward-compatible with existing code) -----

def is_configured() -> bool:
    """Return True if at least one LLM provider has its API key set."""
    from .providers import PROVIDERS
    return any(p.available() for p in PROVIDERS)


def health() -> dict:
    """Return a status dict for /llm/health.

    Backward-compatible: includes the legacy `model` and `api_url` keys
    (used by the original test suite) plus the new multi-provider info.
    """
    configured = is_configured()
    # Primary provider info — new multi-provider module, but kept legacy keys.
    primary_model = os.environ.get("LLM_MODEL") or os.environ.get("GROQ_MODEL", DEFAULT_MODEL)
    primary_url = os.environ.get("LLM_API_URL") or os.environ.get(
        "GROQ_API_URL", "https://api.groq.com/openai/v1/chat/completions"
    )
    return {
        # Legacy keys (kept for backward-compat with existing tests/clients)
        "configured": configured,
        "model": primary_model,
        "api_url": primary_url,
        # New multi-provider keys
        "primary_model": primary_model,
        "primary_api_url": primary_url,
        "providers": _available_providers(),
        "backoff_seconds": float(os.environ.get("LLM_BACKOFF_SECONDS", "5.0")),
        "timeout_seconds": float(os.environ.get("LLM_TIMEOUT_SECONDS", "30.0")),
        "max_attempts": int(os.environ.get("LLM_MAX_ATTEMPTS", "200")),
    }


def plan_with_llm(
    sanitized_event: SanitizedEvent,
    history: Optional[list[dict]] = None,
) -> tuple[dict, str]:
    """
    Call the multi-provider LLM and return the parsed action dict plus
    the display label of the provider that actually answered.

    The priority chain is handled by MultiProviderLLM.generate().
    This function only:
      1. Builds the messages from the sanitized event.
      2. Calls the orchestrator (which loops until a provider succeeds).
      3. Parses and validates the JSON response.

    Returns:
        (action_dict, provider_label) — e.g. ({"action":"click",...}, "Groq").

    Raises:
        RuntimeError  — no provider succeeded after max attempts (or never configured).
        ValueError    — the response could not be parsed as valid JSON.
    """
    if not is_configured():
        raise RuntimeError(
            "No LLM provider is configured. Set at least one of: "
            "GOOGLE_API_KEY, GROQ_API_KEY, OPENROUTER_API_KEY, "
            "NVAPI_KEY / NVIDIA_API_KEY, OMNIROUTE_API_KEY, HF_API_KEY. "
            "See .env.example."
        )

    sanitized_dom = {
        "url": sanitized_event.url,
        "title": sanitized_event.title,
        "elements": sanitized_event.elements,
    }

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": build_user_prompt(sanitized_event.prompt or "", sanitized_dom, history)},
    ]

    logger.info("LLM request → multi-provider chain (Gemini→Groq→OpenRouter→Nvidia→OmniRoute→HF)")
    llm = _get_llm()
    raw_text, provider_name = llm.generate(messages)
    logger.info("LLM response ← provider=%s (%.50s...)", provider_name, raw_text[:50])

    action = _parse_json(raw_text)
    logger.info("LLM action parsed: %s (provider=%s)", action, provider_name)
    return action, provider_name


# ----- Parsing helpers (kept verbatim from original) -----

def _parse_json(text: str) -> dict:
    """
    Parse the model output. The provider should return JSON (we set
    response_format=json_object where supported), but we are defensive:
    strip code fences and find the first {...} block.
    """
    text = text.strip()
    # Strip ```json ... ``` fences if any
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        # Find the first JSON object in the text
        m = re.search(r"\{.*\}", text, re.DOTALL)
        if not m:
            raise ValueError(f"LLM output is not JSON: {text[:200]}")
        return json.loads(m.group(0))


def validate_action_shape(action: Any) -> dict:
    """
    Validate the parsed JSON against the LLM action schema.
    Raises ValueError on failure. Returns the cleaned dict on success.
    """
    if not isinstance(action, dict):
        raise ValueError("LLM action is not an object")

    allowed = {"click", "type", "scroll", "select", "wait", "navigate", "done"}
    a = action.get("action")
    if a not in allowed:
        raise ValueError(f"Invalid action: {a}")

    if a in ("click", "type", "select") and not isinstance(action.get("target"), str):
        raise ValueError(f"{a} requires target")

    if a == "type" and not isinstance(action.get("value"), str):
        raise ValueError("type requires value")

    conf = action.get("confidence", 0.0)
    if not isinstance(conf, (int, float)) or conf < 0 or conf > 1:
        raise ValueError("confidence must be a number in [0, 1]")

    # Normalize done flag
    if a == "done":
        action["done"] = True

    return action


# ----- New convenience export (matches spec's requested function name) -----
def generate_llm_response(prompt: str) -> tuple[str, str]:
    """
    Unified wrapper — try providers in priority order with infinite retry.
    Returns (response_text, provider_name).
    Use this for direct LLM calls outside of the planning context.
    """
    return _generate_llm_response(prompt)
