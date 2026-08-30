"""
RedactVision Agent — LLM Provider Adapters

Three providers, strict priority order, bounded retry:

  1. Groq          — primary
  2. OpenRouter    — secondary (free models / openrouter/free router)
  3. OmniRoute     — third fallback

Removed (deliberately, after live testing showed they are not viable
for this agent workload):
  - Google AI Studio (Gemini): 2.5 family retired for new users; 3.x
    previews return 404 or time out on the chat endpoint.
  - NVIDIA NIM: hardcoded defaults are 410 Gone; /v1/models returns a
    mix of embedding/guard models we cannot safely auto-select from.
  - Hugging Face Inference API: cold-load 503s + key not configured.

All API keys come from environment variables only. No secrets are
hard-coded here (see CLAUDE.md §20 / privacy invariants).

The Provider.call() contract:

    Returns (text, error). On success, error is None.
    On failure, text is "" and error is one of:
        - a plain string (treated as NON-retryable)
        - the string "RETRYABLE: <reason>" (the orchestrator will
          retry the same provider once on this branch before moving
          on, but it will NEVER loop back from provider N to provider 1)

This is the simplest possible interface that lets the orchestrator
classify errors without baking HTTP status codes into a separate
metadata channel.
"""
from __future__ import annotations

import logging
import os
import re
from abc import ABC, abstractmethod
from typing import Optional, Tuple

import httpx

logger = logging.getLogger("redactvision_server.providers")


# ------------------------------------------------------------------
# Per-request model blacklist (so a known-broken slug is never retried
# during the same server process lifetime).
# ------------------------------------------------------------------
_blacklisted: dict[str, set[str]] = {}


def _is_blacklisted(provider: str, model: str) -> bool:
    return model in _blacklisted.get(provider, set())


def _blacklist_model(provider: str, model: str) -> None:
    _blacklisted.setdefault(provider, set()).add(model)


# ------------------------------------------------------------------
# Error classification
# ------------------------------------------------------------------
def _classify(status_code: int) -> str:
    """
    Map an HTTP status code to:
        "non_retryable"  — don't retry, blacklist the model, move on
        "retryable"      — transient error, may retry the same provider once
    """
    if status_code in (400, 401, 403, 404, 410, 422):
        return "non_retryable"
    if status_code in (408, 429, 500, 502, 503, 504):
        return "retryable"
    return "non_retryable"  # unknown status — fail safe


def _err(status_code: int, msg: str) -> str:
    kind = _classify(status_code)
    return f"{kind.upper()}: {msg}" if kind == "retryable" else msg


# ------------------------------------------------------------------
# Provider interface
# ------------------------------------------------------------------
class Provider(ABC):
    name: str = "unknown"

    @abstractmethod
    def available(self) -> bool:
        """Can this provider be used right now (env vars set)?"""
        ...

    @abstractmethod
    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        """
        Call the provider. Return (text_content, error_message_or_None).
        On success error_message is None.
        Error message strings are classified by the orchestrator:
            - "RETRYABLE: ..." means the call may be retried on the
              same provider (transient error, rate limit, timeout).
            - any other non-None error means do NOT retry; move on.
        """
        ...

    def models(self) -> list[str]:
        """
        Ordered list of model slugs to try for this provider, in
        priority order. The first non-blacklisted entry is used.
        """
        return []


# ------------------------------------------------------------------
# 1. Groq (PRIMARY)
# ------------------------------------------------------------------
# Live-tested on 2026-08-30 against the user's key:
#   - groq/compound-mini   → JSON OK, 131k ctx
#   - groq/compound        → 429 (rate-limited for org)
#   - qwen/qwen3.8-27b     → JSON OK, 131k ctx
#   - qwen/qwen3.6-27b     → 400 invalid JSON (rejected)
#   - openai/gpt-oss-120b  → JSON OK, but rejects response_format=json_object
# We therefore exclude qwen3.6-27b and prioritize compound-mini.
GROQ_PRIMARY = "groq/compound-mini"
GROQ_FALLBACKS = [
    "qwen/qwen3.8-27b",
    "openai/gpt-oss-120b",
]


class GroqProvider(Provider):
    name = "groq"

    def available(self) -> bool:
        return bool(os.environ.get("GROQ_API_KEY"))

    def models(self) -> list[str]:
        env_model = os.environ.get("GROQ_MODEL")
        if env_model:
            return [env_model] + [m for m in [GROQ_PRIMARY, *GROQ_FALLBACKS] if m != env_model]
        return [GROQ_PRIMARY, *GROQ_FALLBACKS]

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            return "", "Groq API key missing"
        url = "https://api.groq.com/openai/v1/chat/completions"
        last_error = "Groq all candidate models failed"
        for model in self.models():
            if _is_blacklisted("groq", model):
                continue
            payload: dict = {
                "model": model,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 1024,
            }
            # openai/gpt-oss-* routed through Groq rejects response_format.
            if not model.startswith("openai/"):
                payload["response_format"] = {"type": "json_object"}
            try:
                with httpx.Client(timeout=timeout) as client:
                    resp = client.post(url, json=payload, headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    })
            except httpx.TimeoutException:
                last_error = _err(408, f"Groq timeout for {model}")
                continue
            except Exception as exc:
                return "", f"Groq network error: {exc}"

            if resp.status_code == 200:
                try:
                    body = resp.json()
                    text = body["choices"][0]["message"]["content"]
                    return text, None
                except (KeyError, IndexError, TypeError, ValueError) as exc:
                    return "", f"Groq unexpected response shape: {exc}"

            # Failure path
            err = _err(resp.status_code, f"Groq HTTP {resp.status_code} for {model}: {resp.text[:160]}")
            if resp.status_code in (404, 410):
                _blacklist_model("groq", model)
            last_error = err
        return "", last_error


# ------------------------------------------------------------------
# 2. OpenRouter (SECONDARY, free-only)
# ------------------------------------------------------------------
# Live-tested on 2026-08-30:
#   - Most free models (z-ai/glm-5.2:free, nvidia/nemotron-*:free) hit
#     per-day rate limits with this key.
#   - The `openrouter/free` router works (auto-routes to an available
#     free model that satisfies the request).
#   - The user has not paid for credits, so we use free models only.
OPENROUTER_PRIMARY = "openrouter/free"
OPENROUTER_FALLBACKS = [
    "google/gemma-4-31b-it:free",
    "minimax/minimax-m3:free",
]


class OpenRouterProvider(Provider):
    name = "openrouter"

    def available(self) -> bool:
        return bool(os.environ.get("OPENROUTER_API_KEY"))

    def models(self) -> list[str]:
        # 1) User can pin a specific model via OPENROUTER_FREE_MODELS (comma list)
        # 2) Else use our verified primary + fallback list
        env_models = os.environ.get("OPENROUTER_FREE_MODELS", "").strip()
        if env_models:
            user_list = [m.strip() for m in env_models.split(",") if m.strip()]
            return user_list
        return [OPENROUTER_PRIMARY, *OPENROUTER_FALLBACKS]

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            return "", "OpenRouter API key missing"
        url = "https://openrouter.ai/api/v1/chat/completions"
        last_error = "OpenRouter all candidate models failed"
        for model in self.models():
            if _is_blacklisted("openrouter", model):
                continue
            payload = {
                "model": model,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 1024,
            }
            try:
                with httpx.Client(timeout=timeout) as client:
                    resp = client.post(url, json=payload, headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                        "HTTP-Referer": "https://redactvision.local",
                        "X-Title": "RedactVision Agent",
                    })
            except httpx.TimeoutException:
                last_error = _err(408, f"OpenRouter timeout for {model}")
                continue
            except Exception as exc:
                return "", f"OpenRouter network error: {exc}"

            if resp.status_code == 200:
                try:
                    body = resp.json()
                    text = body["choices"][0]["message"]["content"]
                    # If response_format wasn't used, some models wrap JSON in
                    # markdown fences. Strip them.
                    text = re.sub(r"^```(?:json)?\s*", "", text.strip())
                    text = re.sub(r"\s*```$", "", text)
                    return text, None
                except (KeyError, IndexError, TypeError, ValueError) as exc:
                    return "", f"OpenRouter unexpected response shape: {exc}"

            err = _err(resp.status_code, f"OpenRouter HTTP {resp.status_code} for {model}: {resp.text[:160]}")
            if resp.status_code in (404, 410):
                _blacklist_model("openrouter", model)
            last_error = err
        return "", last_error


# ------------------------------------------------------------------
# 3. OmniRoute (TERTIARY FALLBACK)
# ------------------------------------------------------------------
# OmniRoute — local OpenAI-compatible router.
#
# OmniRoute runs as a local CLI daemon (https://omniroute.ai) on
# http://localhost:20128 by default. It exposes an OpenAI-compatible
# /v1/chat/completions endpoint and routes `auto/*` model names to
# the best underlying model for the task.
#
# Live-tested on 2026-08-30: `auto/best-reasoning` and
# `auto/best-chat` both work and produce structured JSON. The local
# server does NOT require authentication, so the OMNIROUTE_API_KEY
# env var is optional when the URL points at localhost.
# ------------------------------------------------------------------
class OmniRouteProvider(Provider):
    name = "omniroute"

    def __init__(self) -> None:
        self._url = os.environ.get("OMNIROUTE_URL", "http://localhost:20128/v1/chat/completions")
        # `auto/best-reasoning` routes to a strong reasoning model,
        # which is the right pick for browser-automation planning.
        self._model = os.environ.get("OMNIROUTE_MODEL", "auto/best-reasoning")

    def available(self) -> bool:
        # The local OmniRoute server does not require auth, so
        # availability is keyed on the URL being configured (even
        # implicitly via the localhost default). The OMNIROUTE_API_KEY
        # is only added as a Bearer token if it is set.
        return bool(self._url)

    def models(self) -> list[str]:
        return [self._model]

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        model = self._model
        if _is_blacklisted("omniroute", model):
            return "", f"OmniRoute model blacklisted: {model}"
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 1024,
            "stream": False,  # OmniRoute streams SSE by default; we want a JSON response
        }
        headers = {"Content-Type": "application/json"}
        key = os.environ.get("OMNIROUTE_API_KEY")
        if key:
            headers["Authorization"] = f"Bearer {key}"
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(self._url, json=payload, headers=headers)
        except httpx.TimeoutException:
            return "", _err(408, f"OmniRoute timeout for {model}")
        except Exception as exc:
            return "", f"OmniRoute network error: {exc}"

        if resp.status_code == 200:
            try:
                body = resp.json()
                msg = body["choices"][0]["message"]
                # Some OmniRoute-backed models (e.g. openai/gpt-oss-120b
                # via the auto/* routers) put their answer in
                # `reasoning_content` rather than `content`. Fall back
                # to the reasoning text if content is missing.
                text = msg.get("content") or msg.get("reasoning_content") or ""
                if not text:
                    return "", "OmniRoute returned an empty message body"
                return text, None
            except (KeyError, IndexError, TypeError, ValueError) as exc:
                return "", f"OmniRoute unexpected response shape: {exc}"

        err = _err(resp.status_code, f"OmniRoute HTTP {resp.status_code}: {resp.text[:160]}")
        if resp.status_code in (404, 410):
            _blacklist_model("omniroute", model)
        return "", err


# ------------------------------------------------------------------
# Registry
# ------------------------------------------------------------------
PROVIDERS: list[Provider] = [
    GroqProvider(),
    OpenRouterProvider(),
    OmniRouteProvider(),
]
