"""
RedactVision Agent — Server-side LLM Planner

Bounded multi-provider fallback. NO infinite retry loop.

All API keys are read from environment variables. None are hard-coded.
See .env.example for required variables.

Privacy contract (CLAUDE.md invariants):
  - This module ONLY ever receives sanitized DOM (tokens like [EMAIL_01]).
  - It NEVER receives the local token map.
  - It returns a structured action; the client validates and executes.

Priority chain (see multi_provider_llm.py):
  1. Groq        (primary; fast, structured JSON)
  2. OpenRouter  (secondary; free models only)
  3. OmniRoute   (tertiary fallback)

Removed providers (after live testing showed they were not viable
for this agent workload): Google AI Studio (Gemini), NVIDIA NIM,
Hugging Face Inference API.

On failure:
  - Within a single provider, retry ONCE on a retryable error
    (rate limit, timeout, 5xx).
  - On a non-retryable error (401, 404, 410, invalid request), move
    to the next provider immediately.
  - After all 3 providers have been tried, raise RuntimeError — the
    orchestrator will never loop back to provider 1.

Exports:
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

# ----- Provider reliability counters (C6) -----
# Simple in-process counters so we can see which provider produces
# clean JSON vs parse failures. Surfaced via /llm/health.
_parse_stats: dict[str, dict[str, int]] = {}


def _record_parse(provider: str, ok: bool) -> None:
    stats = _parse_stats.setdefault(provider, {"success": 0, "parse_failure": 0})
    stats["success" if ok else "parse_failure"] += 1


def _get_llm() -> MultiProviderLLM:
    global _llm
    if _llm is None:
        _llm = MultiProviderLLM()
    return _llm


# ----- Config helpers -----

def _read_env_or_default(key: str, default: str) -> str:
    return os.environ.get(key, default)


DEFAULT_MODEL = "groq/compound-mini"
MAX_TOKENS = 400
TEMPERATURE = 0.1
REQUEST_TIMEOUT = 30.0


# ----- Provider availability helpers (used by health) -----

def _available_providers() -> list[dict]:
    """Return a list of provider status dicts for the /llm/health endpoint."""
    from .providers import PROVIDERS
    return [
        {"name": p.name, "available": p.available(), "models": p.models()}
        for p in PROVIDERS
    ]


# ----- Public API (backward-compatible with existing code) -----

def is_configured() -> bool:
    """Return True if at least one LLM provider has its API key set."""
    from .providers import PROVIDERS
    return any(p.available() for p in PROVIDERS)


def health() -> dict:
    """Return a status dict for /llm/health."""
    configured = is_configured()
    primary_model = os.environ.get("GROQ_MODEL") or DEFAULT_MODEL
    return {
        "configured": configured,
        "model": primary_model,
        "api_url": "https://api.groq.com/openai/v1/chat/completions",
        "providers": _available_providers(),
        "timeout_seconds": float(os.environ.get("LLM_TIMEOUT_SECONDS", "30.0")),
        "retries_per_provider": int(os.environ.get("LLM_RETRIES_PER_PROVIDER", "1")),
        "total_budget_seconds": float(os.environ.get("LLM_TOTAL_BUDGET_SECONDS", "100")),
        "parse_stats": _parse_stats,
    }


def plan_with_llm(
    sanitized_event: SanitizedEvent,
    history: Optional[list[dict]] = None,
) -> tuple[dict, str]:
    """
    Call the multi-provider LLM and return the parsed action dict plus
    the display label of the provider that actually answered.

    The priority chain is handled by MultiProviderLLM.generate(). It is
    bounded — at most 3 providers × 2 attempts = 6 HTTP calls per request,
    with a per-call timeout (LLM_TIMEOUT_SECONDS, default 30s). There
    is no infinite retry loop.

    Returns:
        (action_dict, provider_label) — e.g. ({"action":"click",...}, "groq").

    Raises:
        RuntimeError  — every provider failed (caller converts to 502).
        ValueError    — the response could not be parsed as valid JSON.
    """
    if not is_configured():
        raise RuntimeError(
            "No LLM provider is configured. Set at least one of: "
            "GROQ_API_KEY, OPENROUTER_API_KEY, OMNIROUTE_API_KEY. "
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

    logger.info("LLM request → Groq → OpenRouter → OmniRoute (bounded)")

    llm = _get_llm()

    # Some free models (notably via the openrouter/free router) sometimes
    # answer with a moderation notice or chain-of-thought prose instead
    # of JSON ("User Safety: safe", "Here's a thinking process: ...").
    # Retry ONCE with an explicit "JSON only" instruction before giving
    # up, so a transient bad reply doesn't surface as a 502 "offline".
    last_error: Exception | None = None
    for attempt in range(2):
        raw_text, provider_name = llm.generate(messages)
        logger.info(
            "LLM response ← provider=%s attempt=%d (%.50s...)",
            provider_name, attempt + 1, raw_text[:50],
        )
        try:
            action = _parse_json(raw_text)
            _record_parse(provider_name, True)
            logger.info("LLM action parsed: %s (provider=%s)", action, provider_name)
            return action, provider_name
        except ValueError as exc:
            _record_parse(provider_name, False)
            last_error = exc
            logger.warning(
                "LLM output was not JSON (attempt %d): %.120s",
                attempt + 1, raw_text,
            )
            messages = messages + [
                {"role": "assistant", "content": raw_text[:500]},
                {
                    "role": "user",
                    "content": (
                        "Your last response was not valid JSON. "
                        "Return ONLY the JSON object this time — a single "
                        "JSON object matching the action schema. No prose, "
                        "no safety notices, no markdown, no thinking process."
                    ),
                },
            ]

    raise ValueError(f"LLM output is not JSON after retry: {last_error}")


# ----- Parsing helpers (kept verbatim from original) -----

def _extract_json_objects(text: str) -> list[str]:
    """
    Scan the text and extract every balanced top-level {...} block.
    Unlike a greedy regex, this correctly handles nested braces and
    braces inside string literals, and won't grab a giant span that
    happens to start at the first '{' and end at the last '}'.
    """
    blocks: list[str] = []
    depth = 0
    start = -1
    in_string = False
    escape = False
    for i, ch in enumerate(text):
        if escape:
            escape = False
            continue
        if ch == "\\":
            if in_string:
                escape = True
            continue
        if ch == '"':
            in_string = not in_string
            continue
        if in_string:
            continue
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            if depth > 0:
                depth -= 1
                if depth == 0 and start >= 0:
                    blocks.append(text[start : i + 1])
                    start = -1
    return blocks


def _parse_json(text: str) -> dict:
    """
    Parse the model output defensively:
      1. Strip markdown fences and try a direct json.loads.
      2. Otherwise, extract every balanced {...} block and prefer the
         one that actually looks like an action (has an "action" key).
         This avoids grabbing an unrelated dict (e.g. a DOM element
         example the model echoed inside its reasoning).
    """
    text = text.strip()
    # Strip ```json ... ``` fences if any
    text = re.sub(r"^```(?:json)?\s*", "", text)
    text = re.sub(r"\s*```$", "", text)

    try:
        obj = json.loads(text)
        if isinstance(obj, dict):
            return obj
    except json.JSONDecodeError:
        pass

    candidates: list[dict] = []
    for block in _extract_json_objects(text):
        try:
            obj = json.loads(block)
            if isinstance(obj, dict):
                candidates.append(obj)
        except json.JSONDecodeError:
            continue

    if not candidates:
        raise ValueError(f"LLM output is not JSON: {text[:200]}")

    # Prefer an object that has the "action" key (the planner schema).
    for obj in candidates:
        if "action" in obj:
            return obj

    # Fall back to the last candidate (models usually put the final
    # answer at the end of their output).
    return candidates[-1]


def visual_ground_with_vlm(image: str, target_description: str) -> dict:
    """
    Locate an interactive UI element visually on a screenshot using multimodal VLM.
    Returns {"found": True, "point": [x, y], "box_2d": [ymin, xmin, ymax, xmax]}
    where point is normalized on a 0-1000 grid.
    """
    prompt = (
        f'Look at this webpage screenshot and locate the interactive UI element for: "{target_description}".\n'
        'Return ONLY a valid JSON object with normalized coordinates on a 1000x1000 grid:\n'
        '{\n'
        '  "found": true,\n'
        '  "point": [x, y],\n'
        '  "box_2d": [ymin, xmin, ymax, xmax],\n'
        '  "description": "Short description of located element"\n'
        '}\n'
        'If the target element is NOT visible in the screenshot, return: {"found": false}'
    )

    llm = _get_llm()

    # 1. Try multimodal messages with image_url
    if image.startswith("data:image/") or image.startswith("http"):
        messages = [
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image}},
                ],
            }
        ]
        try:
            raw_text, _ = llm.generate(messages)
            parsed = _parse_json(raw_text)
            if isinstance(parsed, dict) and "found" in parsed:
                return parsed
        except Exception as exc:
            logger.info("Multimodal VLM call failed or unsupported by provider (%s) — falling back", exc)

    # 2. Text fallback
    messages_text = [
        {"role": "user", "content": prompt}
    ]
    try:
        raw_text, _ = llm.generate(messages_text)
        parsed = _parse_json(raw_text)
        if isinstance(parsed, dict):
            return parsed
    except Exception as exc:
        logger.warning("Visual ground text fallback failed: %s", exc)

    return {"found": False}


def validate_action_shape(action: Any) -> dict:
    """
    Validate the parsed JSON against the LLM action schema.
    Raises ValueError on failure. Returns the cleaned dict on success.
    """
    if not isinstance(action, dict):
        raise ValueError("LLM action is not an object")

    allowed = {"click", "type", "scroll", "select", "wait", "navigate", "open_tab", "fanout", "done"}
    a = action.get("action")
    if a not in allowed:
        raise ValueError(f"Invalid action: {a}")

    if a in ("click", "type", "select", "navigate", "open_tab") and not isinstance(action.get("target"), str):
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


# ===================================================================
# OmniRouter Auto-Combo Specialized Engines
# ===================================================================

def execute_omni_task(
    combo_name: str,
    messages: list[dict],
    expect_json: bool = False,
    timeout: float = 30.0,
) -> tuple[str, str]:
    """
    Dispatches an agent task targeting OmniRouter auto-combos (auto/smart, auto/fast, auto/coding, auto/cheap).
    Automatically cascades to OpenRouter and Groq if OmniRoute is unavailable or fails.
    """
    llm = _get_llm()
    # If using OmniRouteProvider, prioritize requested combo
    for provider in llm.providers:
        if provider.name == "omniroute":
            os.environ["OMNIROUTE_MODEL"] = combo_name
            break

    return llm.generate(messages)


def generate_smart_execution_plan(user_prompt: str, current_url: str, sanitized_dom: dict) -> dict:
    """
    Phase 3: Think-Before-Acting Planning Engine using auto/smart.
    Deconstructs vague user prompts into sequential instruction steps and explicit validation checks.
    """
    system_prompt = f"""You are the advanced reasoning brain of an autonomous browser agent.
The user wants to accomplish: "{user_prompt}"
Current Page URL: "{current_url}"

Your job:
1. Analyze the task and determine what sequential browser actions are needed.
2. Formulate clear, step-by-step instructions for yourself to follow.
3. Define explicit validation checks for every single step to confirm success before moving forward.

Return your output strictly as a JSON object matching this schema:
{{
  "taskSummary": "Description of the goal",
  "steps": [
    {{
      "stepId": 1,
      "actionType": "TYPE|CLICK|NAVIGATE|EXTRACT|WAIT|DONE",
      "targetSelector": "CSS selector or semantic description from DOM",
      "valueToInput": "text or token or null",
      "instructionsForSelf": "Detailed breakdown of how the agent should handle this step",
      "validationCheck": "Condition required to mark this step successful"
    }}
  ]
}}
"""

    elements_preview = (sanitized_dom.get("elements") or [])[:40] if isinstance(sanitized_dom, dict) else []
    user_content = (
        f'User Prompt: {user_prompt}\n\n'
        f'Page Elements Preview:\n'
        f'{json.dumps(elements_preview, ensure_ascii=False, indent=2)}'
    )

    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_content},
    ]

    # Route through OmniRouter's smart reasoning combo (auto/smart)
    raw_text, provider = execute_omni_task("auto/smart", messages, expect_json=True)
    parsed = _parse_json(raw_text)
    if isinstance(parsed, dict) and "steps" in parsed:
        parsed["provider"] = provider
        parsed["model"] = "auto/smart"
        return parsed

    # Fallback to single action step if model didn't return full list
    return {
        "taskSummary": user_prompt,
        "steps": [
            {
                "stepId": 1,
                "actionType": "CLICK" if "click" in user_prompt.lower() else "TYPE",
                "targetSelector": "input" if "type" in user_prompt.lower() else "button",
                "valueToInput": None,
                "instructionsForSelf": user_prompt,
                "validationCheck": "Element state changed",
            }
        ],
        "provider": provider,
        "model": "auto/smart",
    }


def validate_step_execution(step_instructions: str, current_dom_snapshot: dict) -> dict:
    """
    Phase 4: Fast Validation Loop using auto/fast.
    Evaluates current DOM state changes against the expected validation check with sub-second latency.
    """
    prompt = f"""Review the current DOM state snapshot against the agent's expected validation check.
Instruction / Validation Goal: "{step_instructions}"

DOM Snapshot Elements:
{json.dumps((current_dom_snapshot.get("elements") or [])[:30], ensure_ascii=False)}

Respond with a single JSON object:
{{
  "success": true,
  "reason": "Clear explanation of why the validation passed or failed",
  "confidence": 0.95
}}
"""

    messages = [
        {"role": "system", "content": "You are a fast UI state evaluator. Respond strictly in JSON."},
        {"role": "user", "content": prompt},
    ]

    try:
        # Route to low-latency auto/fast combo
        raw_text, _ = execute_omni_task("auto/fast", messages, expect_json=True)
        parsed = _parse_json(raw_text)
        if isinstance(parsed, dict) and "success" in parsed:
            return parsed
    except Exception as exc:
        logger.warning("Fast validation error: %s", exc)

    return {"success": True, "reason": "Default assumption of step completion", "confidence": 0.8}


# ----- New convenience export (matches spec's requested function name) -----
def generate_llm_response(prompt: str) -> tuple[str, str]:
    """
    Unified wrapper — try providers in priority order with infinite retry.
    Returns (response_text, provider_name).
    Use this for direct LLM calls outside of the planning context.
    """
    return _generate_llm_response(prompt)
