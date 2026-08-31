"""
RedactVision Agent — Bounded multi-provider LLM fallback

Strict priority order, NO infinite retry loop:

    Groq (primary)
        ↓ on hard failure
    OpenRouter (secondary)
        ↓ on hard failure
    OmniRoute (tertiary)
        ↓ on hard failure
    FAILED (clean error, no further attempts)

Within a single provider, we may retry ONCE on a retryable error
(rate limit, timeout, 5xx). On a non-retryable error (401, 404, 410,
invalid request), we move to the next provider immediately.

This is the deliberate opposite of an infinite-retry loop: a single
/llm/plan HTTP request can attempt at most 3 providers × 2 calls = 6
HTTP calls before giving up. The orchestrator will never loop back
to provider 1 after provider 3 has been tried.
"""
from __future__ import annotations

import os
import logging
import time
from typing import Optional, List, Tuple

from .providers import PROVIDERS, Provider

logger = logging.getLogger("redactvision_server.multi_provider_llm")

# Total wall-clock budget for ONE planning request across the whole
# provider chain. The client aborts at 120s, so the server must finish
# (or give up) BEFORE that. Default 100s leaves a safety margin.
TOTAL_BUDGET_SECONDS = float(os.environ.get("LLM_TOTAL_BUDGET_SECONDS", "100"))


class MultiProviderLLM:
    """
    Sequential provider chain. Bounded by design.
    """

    def __init__(
        self,
        providers: Optional[List[Provider]] = None,
        timeout_per_call: float = 30.0,
        max_retries_per_provider: int = 1,
    ):
        self.providers = providers if providers is not None else list(PROVIDERS)
        self.timeout = float(os.environ.get("LLM_TIMEOUT_SECONDS", timeout_per_call))
        # On a retryable error within one provider, retry at most N times
        # before moving to the next provider. Default 1 means: try once,
        # if retryable, try once more, then move on.
        self.max_retries_per_provider = int(os.environ.get(
            "LLM_RETRIES_PER_PROVIDER", str(max_retries_per_provider)
        ))

    def generate(self, messages: list[dict]) -> Tuple[str, str]:
        """
        Try providers in strict priority order. Bounded — never loops
        back to provider 1 after provider N has been tried.

        Returns:
            (response_text, provider_name_that_answered)

        Raises:
            RuntimeError — every provider was unavailable or returned
                a non-retryable error. The error message enumerates
                which providers were tried and why each failed.
        """
        attempts: list[str] = []  # human-readable audit trail
        started = time.monotonic()

        for provider in self.providers:
            if not provider.available():
                attempts.append(f"{provider.name}: unavailable (no key)")
                logger.info("Provider %s unavailable — skipping", provider.name)
                continue

            # Respect the total budget: if we've already burned most of
            # it, don't start another provider — the client would have
            # aborted by the time a slow chain finished.
            elapsed = time.monotonic() - started
            if elapsed > TOTAL_BUDGET_SECONDS * 0.6 and attempts:
                logger.warning(
                    "Total LLM budget %.0fs nearly exhausted (%.1fs used) — "
                    "stopping chain before %s",
                    TOTAL_BUDGET_SECONDS, elapsed, provider.name,
                )
                attempts.append(f"{provider.name}: skipped (total budget)")
                break

            for attempt_idx in range(self.max_retries_per_provider + 1):
                try:
                    text, err = provider.call(messages, timeout=self.timeout)
                except Exception as exc:
                    # Defensive: provider.call should catch its own
                    # exceptions, but a crash here must not loop.
                    text, err = "", f"unexpected provider crash: {exc}"

                if text and not err:
                    logger.info(
                        "LLM success — provider=%s attempt=%d",
                        provider.name, attempt_idx + 1,
                    )
                    return text, provider.name

                # Failure path
                is_retryable = bool(err) and err.upper().startswith("RETRYABLE:")
                attempts.append(f"{provider.name}: {err}")

                if is_retryable and attempt_idx < self.max_retries_per_provider:
                    logger.warning(
                        "LLM retryable failure — provider=%s attempt=%d/%d error=%s",
                        provider.name, attempt_idx + 1, self.max_retries_per_provider + 1, err,
                    )
                    continue  # retry same provider

                # Non-retryable, or out of retries on this provider
                logger.warning(
                    "LLM failure — provider=%s attempt=%d error=%s — moving to next provider",
                    provider.name, attempt_idx + 1, err,
                )
                break  # move to next provider

        # All providers exhausted — bounded failure
        summary = " | ".join(attempts) if attempts else "no providers were even attempted"
        logger.error("LLM chain failed: %s", summary)
        raise RuntimeError(
            f"All configured LLM providers failed. {summary}"
        )


# ------------------------------------------------------------------
# Singleton accessor
# ------------------------------------------------------------------
_default_llm: Optional[MultiProviderLLM] = None


def get_llm() -> MultiProviderLLM:
    global _default_llm
    if _default_llm is None:
        _default_llm = MultiProviderLLM()
    return _default_llm


def generate_llm_response(prompt: str) -> Tuple[str, str]:
    """
    Convenience wrapper for ad-hoc LLM calls (not the /llm/plan
    planning flow, which goes through llm.plan_with_llm).

    Returns: (response_text, provider_name)
    Raises: RuntimeError if every provider fails.
    """
    llm = get_llm()
    messages = [
        {"role": "system", "content": "You are RedactVision Agent. Return structured JSON actions only."},
        {"role": "user", "content": prompt},
    ]
    return llm.generate(messages)
