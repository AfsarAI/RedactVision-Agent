"""
RedactVision Agent — Multi-Provider Fallback & Retry Loop Mechanism

Strict priority chain:
  1. Gemini (Google AI Studio)
  2. Groq
  3. OpenRouter (free-model iteration)
  4. NVIDIA NIM
  5. OmniRoute
  6. Hugging Face Inference API

If ALL fail: configurable backoff (default 5.0 s) and restart from Priority 1.
This loop runs infinitely until a response is received.

Important privacy notes (CLAUDE.md invariants):
- No provider adapter receives the local token map.
- Only sanitized DOM / messages are transmitted.
- Errors are logged but never contain raw PII.
- No API keys are embedded in this file; they come from ENV only.
"""
from __future__ import annotations

import time
import os
import logging
from typing import Optional, List

from .providers import PROVIDERS, Provider

logger = logging.getLogger("redactvision_server.multi_provider_llm")


class MultiProviderLLM:
    """
    Unified wrapper over 6 LLM providers with strict priority
    and an infinite retry/backoff loop.
    """

    def __init__(
        self,
        providers: Optional[List[Provider]] = None,
        backoff_seconds: float = 5.0,
        max_retries_per_provider: int = 1,
        timeout_per_call: float = 30.0,
    ):
        self.providers = providers or PROVIDERS
        self.backoff = float(os.environ.get("LLM_BACKOFF_SECONDS", backoff_seconds))
        self.timeout = float(os.environ.get("LLM_TIMEOUT_SECONDS", timeout_per_call))
        self.max_retries_per_provider = max_retries_per_provider

    def generate_llm_response(self, prompt: str) -> tuple[str, str]:
        """
        Try providers sequentially in strict priority order.
        Returns (response_text, provider_name_that_succeeded).

        Raises RuntimeError if an unrecoverable state occurs
        (should not normally happen because of the infinite loop).
        """
        # For planner-style LLM interaction we wrap the user prompt in messages.
        # The caller passes a text prompt (e.g. sanitized user task); we wrap it.
        messages = [
            {"role": "system", "content": "You are RedactVision Agent. Return structured JSON actions only."},
            {"role": "user", "content": prompt},
        ]
        return self.generate(messages)

    def generate(self, messages: list[dict]) -> tuple[str, str]:
        """
        The core retry loop.
        """
        # Safety guard: never loop more than 200 attempts (approx 1000 s at 5 s backoff)
        # before forcing an exception — protects against runaway loops in production.
        # In practice the loop is intended to be infinite; this guard is a fail-safe.
        max_total_attempts = int(os.environ.get("LLM_MAX_ATTEMPTS", "200"))
        attempt = 0
        while True:
            attempt += 1
            for provider in self.providers:
                if not provider.available():
                    logger.debug("Provider %s unavailable — skipping", provider.name)
                    continue

                # Attempt this provider
                for retry in range(self.max_retries_per_provider):
                    try:
                        text, err = provider.call(messages, timeout=self.timeout)
                    except Exception as exc:
                        # Defensive: provider.call should catch its own exceptions,
                        # but we guard against unexpected crashes.
                        text, err = "", f"Unexpected provider crash ({provider.name}): {exc}"

                    if text and not err:
                        logger.info(
                            "LLM success — provider=%s attempt=%d retry=%d",
                            provider.name,
                            attempt,
                            retry,
                        )
                        return text, provider.name

                    # Failure path
                    logger.warning(
                        "LLM failure — provider=%s attempt=%d retry=%d error=%s",
                        provider.name,
                        attempt,
                        retry,
                        err or "empty response",
                    )

                    # For rate-limit errors (429) we don't immediately retry the same provider
                    # within the inner retry; the outer loop's backoff handles it.
                    # If it was just a transient error, we break out to backoff.
                    # If it was a non-transient failure (401, bad payload), we still
                    # attempt the next provider — but don't spam retries.

                    # Small intra-provider delay on retryable errors
                    retryable = ("429" in (err or "") or "503" in (err or "") or "timeout" in (err or ""))
                    if retry < self.max_retries_per_provider - 1 and retryable:
                        delay = 0.5 * (retry + 1)
                        logger.info("Retrying %s in %.1fs (retryable error)", provider.name, delay)
                        time.sleep(delay)

            # All providers exhausted — backoff and restart from Priority 1
            logger.error(
                "All %d providers failed on attempt %d. Backing off %.1fs before restart...",
                len(self.providers),
                attempt,
                self.backoff,
            )
            if attempt >= max_total_attempts:
                raise RuntimeError(
                    f"LLM multi-provider loop exceeded max attempts ({max_total_attempts}). "
                    "No provider returned a response. Check API keys and network."
                )
            time.sleep(self.backoff)
            # After backoff we naturally restart from provider 1 (Gemini)


# ------------------------------------------------------------------
# Convenience singleton / function interface
# ------------------------------------------------------------------
_default_llm: Optional[MultiProviderLLM] = None


def get_llm(config_backoff: Optional[float] = None) -> MultiProviderLLM:
    """Lazy singleton — avoids creating a new loop on every import."""
    global _default_llm
    if _default_llm is None:
        _default_llm = MultiProviderLLM(backoff_seconds=config_backoff or 5.0)
    return _default_llm


def generate_llm_response(prompt: str, backoff_seconds: float = 5.0) -> tuple[str, str]:
    """
    Unified wrapper function requested in spec.
    Tries providers in priority order with infinite retry/backoff loop.

    Returns: (response_text, provider_name_used)
    Raises: RuntimeError only if the absolute safety cap is exceeded.
    """
    llm = get_llm(config_backoff=backoff_seconds)
    return llm.generate_llm_response(prompt)
