"""
RedactVision Agent — Multi-Provider LLM Adapters

Each adapter reads from environment variables only.
No API keys are hard-coded (see CLAUDE.md §20 / privacy invariants).

Supported providers (priority order defined in multi_provider_llm.py):
  1. Google AI Studio (Gemini)
  2. Groq
  3. OpenRouter (free-model iteration)
  4. NVIDIA NIM  (you supplied nvapi key — included here)
  5. OmniRoute
  6. Hugging Face Inference API
"""
from __future__ import annotations

import os
import logging
from typing import Optional, Tuple
from abc import ABC, abstractmethod

import httpx

logger = logging.getLogger("redactvision_server.providers")


# ------------------------------------------------------------------
# Model discovery state
# ------------------------------------------------------------------
# `active_models` maps provider name -> the model slug that the
# discovery step has chosen as the working default.
# `blacklisted` maps provider name -> set of model slugs that have
# returned 404 / 410 at least once (and should not be retried).
_active_models: dict[str, str] = {}
_blacklisted: dict[str, set[str]] = {}


def _get_active_model(provider: str) -> Optional[str]:
    return _active_models.get(provider)


def _set_active_model(provider: str, model: str) -> None:
    _active_models[provider] = model


def _is_blacklisted(provider: str, model: str) -> bool:
    return model in _blacklisted.get(provider, set())


def _blacklist_model(provider: str, model: str) -> None:
    _blacklisted.setdefault(provider, set()).add(model)
    # If the model that just got blacklisted was the active one, clear it.
    if _active_models.get(provider) == model:
        _active_models.pop(provider, None)


def discover_all(timeout: float = 10.0) -> dict[str, Optional[str]]:
    """
    Run discover() on every available provider. Returns a map of
    provider name -> discovered model slug (or None).
    """
    results: dict[str, Optional[str]] = {}
    for p in PROVIDERS:
        if not p.available():
            continue
        try:
            slug = p.discover(timeout=timeout)
        except Exception as exc:
            logger.warning("Discover for %s raised: %s", p.name, exc)
            slug = None
        results[p.name] = slug
        if slug:
            _set_active_model(p.name, slug)
            logger.info("Discovered active model: %s -> %s", p.name, slug)
    return results

# ------------------------------------------------------------------
# Common interface
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
        """
        ...

    def discover(self, timeout: float = 10.0) -> Optional[str]:
        """
        Return the slug of a working model on this provider, or None if
        discovery is not supported / failed. Default implementation: try
        the env-var default model; if that fails, return None.
        Subclasses with a real /models list endpoint override this.
        """
        return None


# ------------------------------------------------------------------
# 1. Google AI Studio (Gemini)
# ------------------------------------------------------------------
class GeminiProvider(Provider):
    name = "gemini"

    def available(self) -> bool:
        return bool(os.environ.get("GOOGLE_API_KEY"))

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("GOOGLE_API_KEY")
        # Use the env var if set, else use the auto-discovered model,
        # else fall back to a sensible default.
        env_model = os.environ.get("GEMINI_MODEL")
        model = env_model or _get_active_model("gemini") or "gemini-1.5-flash"
        if not key:
            return "", "Google API key missing"

        # Gemini uses generateContent endpoint with contents/messages shaped differently
        # We build a payload that maps OpenAI-style messages to Gemini format.
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={key}"

        # Minimal mapping: system -> systemInstruction, user -> user, assistant -> model
        contents = []
        system_text = None
        for m in messages:
            role = m.get("role")
            content = m.get("content", "")
            if role == "system":
                system_text = content
            else:
                contents.append({"role": "user" if role == "user" else "model", "parts": [{"text": content}]})

        payload: dict = {"contents": contents, "generationConfig": {"temperature": 0.1, "maxOutputTokens": 1024}}
        if system_text:
            payload["systemInstruction"] = {"parts": [{"text": system_text}]}

        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(url, json=payload, headers={"Content-Type": "application/json"})
        except Exception as exc:
            return "", f"Gemini network error: {exc}"

        if resp.status_code == 429:
            return "", f"Gemini rate limit (429)"
        if resp.status_code == 401:
            return "", f"Gemini unauthorized (401)"
        if resp.status_code == 404:
            # If the configured/discovered model doesn't exist, blacklist it
            # for the rest of this server lifetime so the loop moves on.
            _blacklist_model("gemini", model)
            return "", f"Gemini model not found: {model}"
        if resp.status_code >= 500:
            return "", f"Gemini server error {resp.status_code}"
        if resp.status_code != 200:
            return "", f"Gemini HTTP {resp.status_code}: {resp.text[:200]}"

        try:
            body = resp.json()
            text = body["candidates"][0]["content"]["parts"][0]["text"]
        except (KeyError, IndexError, TypeError) as exc:
            return "", f"Gemini unexpected response shape: {exc}"

        return text, None

    def discover(self, timeout: float = 10.0) -> Optional[str]:
        """List Gemini models that support generateContent, return the first one."""
        key = os.environ.get("GOOGLE_API_KEY")
        if not key:
            return None
        url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(url, headers={"Content-Type": "application/json"})
            if resp.status_code != 200:
                return None
            body = resp.json()
            for m in body.get("models", []):
                if "generateContent" in m.get("supportedGenerationMethods", []):
                    # The 'name' field is like "models/gemini-1.5-flash" — strip the prefix.
                    full_name = m.get("name", "")
                    if full_name.startswith("models/"):
                        return full_name[len("models/"):]
            return None
        except Exception:
            return None


# ------------------------------------------------------------------
# 2. Groq
# ------------------------------------------------------------------
class GroqProvider(Provider):
    name = "groq"

    def available(self) -> bool:
        return bool(os.environ.get("GROQ_API_KEY"))

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("GROQ_API_KEY")
        env_model = os.environ.get("GROQ_MODEL")
        # Build candidate list: env-var model first, then active model, then spec fallbacks.
        candidates = []
        if env_model:
            candidates.append(env_model)
        active = _get_active_model("groq")
        if active and active not in candidates:
            candidates.append(active)
        for fallback in ("llama-3.3-70b-versatile", "llama-3.1-8b-instant"):
            if fallback not in candidates and not _is_blacklisted("groq", fallback):
                candidates.append(fallback)

        url = "https://api.groq.com/openai/v1/chat/completions"
        for model in candidates:
            if _is_blacklisted("groq", model):
                continue
            payload = {
                "model": model,
                "messages": messages,
                "temperature": 0.1,
                "max_tokens": 1024,
                "response_format": {"type": "json_object"},
            }
            try:
                with httpx.Client(timeout=timeout) as client:
                    resp = client.post(url, json=payload, headers={
                        "Authorization": f"Bearer {key}",
                        "Content-Type": "application/json",
                    })
            except Exception as exc:
                return "", f"Groq network error: {exc}"

            if resp.status_code == 429:
                logger.warning("Groq rate limit (429) for model %s — will try fallback model", model)
                continue
            if resp.status_code == 401:
                return "", "Groq unauthorized (401)"
            if resp.status_code == 404:
                _blacklist_model("groq", model)
                logger.warning("Groq model not found: %s — trying next", model)
                continue
            if resp.status_code >= 500:
                return "", f"Groq server error {resp.status_code}"
            if resp.status_code != 200:
                return "", f"Groq HTTP {resp.status_code}: {resp.text[:200]}"

            try:
                body = resp.json()
                text = body["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError) as exc:
                return "", f"Groq unexpected response shape: {exc}"
            return text, None
        return "", "Groq all candidate models failed"

    def discover(self, timeout: float = 10.0) -> Optional[str]:
        """List Groq models, prefer chat-tuned llama-3.x over guard models."""
        key = os.environ.get("GROQ_API_KEY")
        if not key:
            return None
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(
                    "https://api.groq.com/openai/v1/models",
                    headers={"Authorization": f"Bearer {key}"},
                )
            if resp.status_code != 200:
                return None
            body = resp.json()
            ids = [m.get("id") for m in body.get("data", []) if m.get("id")]
            # Prefer chat/instruct, large llama-3.x, in that order.
            priority_keywords = [
                "llama-3.3-70b-versatile",
                "llama-3.1-70b-versatile",
                "llama-3.1-8b-instant",
                "llama-3.3-70b",
                "llama-3.1-70b",
                "llama-3.1-8b",
                "llama-3.3-8b",
                "mixtral-8x7b",
            ]
            for kw in priority_keywords:
                for mid in ids:
                    if kw in mid and not _is_blacklisted("groq", mid):
                        return mid
            # Last resort: any llama-3.x.
            for mid in ids:
                if "llama-3" in mid and not _is_blacklisted("groq", mid):
                    return mid
            return ids[0] if ids else None
        except Exception:
            return None


# ------------------------------------------------------------------
# 3. OpenRouter
# ------------------------------------------------------------------
class OpenRouterProvider(Provider):
    name = "openrouter"

    def available(self) -> bool:
        return bool(os.environ.get("OPENROUTER_API_KEY"))

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("OPENROUTER_API_KEY")
        # Per your spec: dynamically iterate over free models tagged :free
        url = "https://openrouter.ai/api/v1/chat/completions"
        free_models = [
            "google/gemini-2.5-flash:free",
            "meta-llama/llama-3.3-70b-instruct:free",
            "deepseek/deepseek-r1:free",
        ]
        extra = os.environ.get("OPENROUTER_FREE_MODELS", "")
        if extra:
            free_models.extend([m.strip() for m in extra.split(",") if m.strip()])
        # Drop blacklisted ones.
        free_models = [m for m in free_models if not _is_blacklisted("openrouter", m)]

        for model in free_models:
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
            except Exception as exc:
                return "", f"OpenRouter network error: {exc}"

            if resp.status_code == 429:
                logger.warning("OpenRouter rate limit (429) for %s — try next free model", model)
                continue
            if resp.status_code == 401:
                return "", "OpenRouter unauthorized (401)"
            if resp.status_code == 404 or resp.status_code == 410:
                _blacklist_model("openrouter", model)
                logger.info("OpenRouter model gone (%s/%s) — blacklisting", model, resp.status_code)
                continue
            if resp.status_code >= 500:
                return "", f"OpenRouter server error {resp.status_code}"
            if resp.status_code != 200:
                logger.info("OpenRouter HTTP %s for %s: %s — continuing", resp.status_code, model, resp.text[:120])
                continue

            try:
                body = resp.json()
                text = body["choices"][0]["message"]["content"]
            except (KeyError, IndexError, TypeError) as exc:
                return "", f"OpenRouter unexpected response: {exc}"
            return text, None
        return "", "OpenRouter all free models failed"

    def discover(self, timeout: float = 10.0) -> Optional[str]:
        """List free OpenRouter models, return the first :free one."""
        key = os.environ.get("OPENROUTER_API_KEY")
        if not key:
            return None
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Authorization": f"Bearer {key}"},
                )
            if resp.status_code != 200:
                return None
            body = resp.json()
            for m in body.get("data", []):
                mid = m.get("id", "")
                # Prefer :free variants for the demo.
                if mid.endswith(":free"):
                    return mid
            return None
        except Exception:
            return None


# ------------------------------------------------------------------
# 4. NVIDIA NIM (you supplied nvapi-...)
# ------------------------------------------------------------------
class NVIDIAProvider(Provider):
    name = "nvidia"

    def available(self) -> bool:
        # Accept either NIM_ or NVIDIA_ prefix; also accept generic NVAPI_KEY
        return bool(
            os.environ.get("NVAPI_KEY")
            or os.environ.get("NVIDIA_API_KEY")
            or os.environ.get("NIM_API_KEY")
        )

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("NVAPI_KEY") or os.environ.get("NVIDIA_API_KEY") or os.environ.get("NIM_API_KEY")
        base = os.environ.get("NVIDIA_NIM_URL", "https://integrate.api.nvidia.com/v1/chat/completions")
        env_model = os.environ.get("NVIDIA_MODEL")
        model = env_model or _get_active_model("nvidia") or "meta/llama-3.1-70b-instruct"
        if _is_blacklisted("nvidia", model):
            return "", f"NVIDIA model blacklisted: {model}"
        payload = {
            "model": model,
            "messages": messages,
            "temperature": 0.1,
            "max_tokens": 1024,
        }
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(base, json=payload, headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                })
        except Exception as exc:
            return "", f"NVIDIA NIM network error: {exc}"

        if resp.status_code == 429:
            return "", f"NVIDIA rate limit (429)"
        if resp.status_code == 401:
            return "", f"NVIDIA unauthorized (401)"
        if resp.status_code == 404 or resp.status_code == 410:
            _blacklist_model("nvidia", model)
            return "", f"NVIDIA model gone ({resp.status_code}): {model}"
        if resp.status_code >= 500:
            return "", f"NVIDIA server error {resp.status_code}"
        if resp.status_code != 200:
            return "", f"NVIDIA HTTP {resp.status_code}: {resp.text[:200]}"

        try:
            body = resp.json()
            text = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            return "", f"NVIDIA unexpected response: {exc}"
        return text, None

    def discover(self, timeout: float = 10.0) -> Optional[str]:
        """List NVIDIA NIM models, prefer chat/instruct over safety/embedding."""
        key = os.environ.get("NVAPI_KEY") or os.environ.get("NVIDIA_API_KEY") or os.environ.get("NIM_API_KEY")
        if not key:
            return None
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(
                    "https://integrate.api.nvidia.com/v1/models",
                    headers={"Authorization": f"Bearer {key}"},
                )
            if resp.status_code != 200:
                return None
            body = resp.json()
            ids = [m.get("id") for m in body.get("data", []) if m.get("id")]
            # Prefer chat-tuned models. Avoid safety/guard/embed.
            skip_keywords = ("guard", "safety", "embed", "rerank", "nemo")
            priority_keywords = (
                "llama-3.1-70b-instruct",
                "llama-3.3-70b-instruct",
                "llama-3.1-8b-instruct",
                "mixtral-8x7b-instruct",
                "qwen-2.5-72b-instruct",
                "qwen-2.5-7b-instruct",
            )
            for kw in priority_keywords:
                for mid in ids:
                    if kw in mid and not any(s in mid.lower() for s in skip_keywords) and not _is_blacklisted("nvidia", mid):
                        return mid
            for mid in ids:
                low = mid.lower()
                if any(s in low for s in skip_keywords):
                    continue
                if "instruct" in low or "chat" in low:
                    if not _is_blacklisted("nvidia", mid):
                        return mid
            return ids[0] if ids else None
        except Exception:
            return None


# ------------------------------------------------------------------
# 5. OmniRoute
# ------------------------------------------------------------------
class OmniRouteProvider(Provider):
    name = "omniroute"

    def available(self) -> bool:
        return bool(os.environ.get("OMNIROUTE_API_KEY"))

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("OMNIROUTE_API_KEY")
        url = os.environ.get("OMNIROUTE_URL", "https://api.omniroute.ai/v1/chat/completions")
        env_model = os.environ.get("OMNIROUTE_MODEL")
        model = env_model or _get_active_model("omniroute") or "omni"
        if _is_blacklisted("omniroute", model):
            return "", f"OmniRoute model blacklisted: {model}"
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
                })
        except Exception as exc:
            return "", f"OmniRoute network error: {exc}"

        if resp.status_code == 429:
            return "", f"OmniRoute rate limit (429)"
        if resp.status_code == 401:
            return "", f"OmniRoute unauthorized (401)"
        if resp.status_code == 404 or resp.status_code == 410:
            _blacklist_model("omniroute", model)
            return "", f"OmniRoute model gone ({resp.status_code}): {model}"
        if resp.status_code >= 500:
            return "", f"OmniRoute server error {resp.status_code}"
        if resp.status_code != 200:
            return "", f"OmniRoute HTTP {resp.status_code}: {resp.text[:200]}"

        try:
            body = resp.json()
            text = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            return "", f"OmniRoute unexpected response: {exc}"
        return text, None

    def discover(self, timeout: float = 10.0) -> Optional[str]:
        key = os.environ.get("OMNIROUTE_API_KEY")
        if not key:
            return None
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.get(
                    "https://api.omniroute.ai/v1/models",
                    headers={"Authorization": f"Bearer {key}"},
                )
            if resp.status_code != 200:
                return None
            body = resp.json()
            ids = [m.get("id") for m in body.get("data", []) if m.get("id")]
            return ids[0] if ids else None
        except Exception:
            return None


# ------------------------------------------------------------------
# 6. Hugging Face Inference API
# ------------------------------------------------------------------
class HFProvider(Provider):
    name = "hf"

    def available(self) -> bool:
        return bool(os.environ.get("HF_API_KEY"))

    def call(self, messages: list[dict], timeout: float = 30.0) -> Tuple[str, Optional[str]]:
        key = os.environ.get("HF_API_KEY")
        # Default to a lightweight instruct model; can be overridden
        model = os.environ.get("HF_MODEL", "mistralai/Mistral-7B-Instruct-v0.3")
        # HF inference endpoint for serverless
        url = f"https://api-inference.huggingface.co/models/{model}"
        # HF inference accepts a different payload (inputs as string for chat models)
        # For simplicity we concatenate messages into a prompt
        prompt_text = "\n".join(
            f"{m['role']}: {m['content']}" for m in messages if m.get("content")
        )
        payload = {
            "inputs": prompt_text,
            "parameters": {"max_new_tokens": 1024, "temperature": 0.1},
        }
        try:
            with httpx.Client(timeout=timeout) as client:
                resp = client.post(url, json=payload, headers={
                    "Authorization": f"Bearer {key}",
                    "Content-Type": "application/json",
                })
        except Exception as exc:
            return "", f"HF network error: {exc}"

        # HF inference can return 503 when model is cold/loading
        if resp.status_code == 503:
            return "", f"HF model loading (503) — retry later"
        if resp.status_code == 429:
            return "", f"HF rate limit (429)"
        if resp.status_code == 401:
            return "", f"HF unauthorized (401)"
        if resp.status_code >= 500:
            return "", f"HF server error {resp.status_code}"
        if resp.status_code != 200:
            return "", f"HF HTTP {resp.status_code}: {resp.text[:200]}"

        try:
            body = resp.json()
            # HF serverless can return a list with "generated_text"
            if isinstance(body, list) and len(body) > 0:
                generated = body[0].get("generated_text", "")
            elif isinstance(body, dict):
                generated = body.get("generated_text", "")
            else:
                generated = str(body)
            # Remove input prompt from output if present
            if generated.startswith(prompt_text):
                generated = generated[len(prompt_text):].lstrip("\n ")
            return generated, None
        except Exception as exc:
            return "", f"HF unexpected response: {exc}"


# ------------------------------------------------------------------
# Registry — used by orchestrator
# ------------------------------------------------------------------
PROVIDERS = [
    GeminiProvider(),
    GroqProvider(),
    OpenRouterProvider(),
    NVIDIAProvider(),
    OmniRouteProvider(),
    HFProvider(),
]
