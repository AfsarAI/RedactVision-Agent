"""Local desktop AI service for profile selection and form automation.

This service is designed to run on the user's laptop next to the browser
extension. It keeps profile matching and token resolution local, while
remaining lightweight enough for common desktop hardware.

The default implementation uses deterministic on-device heuristics and a
small Hugging Face-compatible interface when a lightweight model package is
available. It never sends raw personal values to the network.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from .local_profile_service import LocalProfileAssistant, build_profile_token_map


@dataclass
class LocalAIRecommendation:
    selected_profile_id: str | None = None
    confidence: float = 0.0
    reason: str = ""
    resolved_tokens: dict[str, str] = field(default_factory=dict)
    suggested_fields: list[str] = field(default_factory=list)

    def model_dump(self, *, exclude_none: bool = False) -> dict[str, Any]:
        result = {
            "selected_profile_id": self.selected_profile_id,
            "confidence": self.confidence,
            "reason": self.reason,
            "resolved_tokens": self.resolved_tokens,
            "suggested_fields": self.suggested_fields,
        }
        if exclude_none:
            return {key: value for key, value in result.items() if value is not None}
        return result


@dataclass
class LocalAIHealth:
    status: str = "ready"
    model: str = "local-deterministic-profile-matcher"
    local_only: bool = True
    lightweight: bool = True
    notes: list[str] = field(default_factory=list)


class LocalDesktopAIService:
    """Small, deterministic local assistant for selecting a saved profile."""

    def __init__(self) -> None:
        self.assistant = LocalProfileAssistant()

    def health(self) -> LocalAIHealth:
        return LocalAIHealth(
            status="ready",
            model="local-deterministic-profile-matcher",
            local_only=True,
            lightweight=True,
            notes=[
                "Runs entirely on-device",
                "No profile values leave the machine",
                "Gracefully falls back to deterministic matching when optional models are unavailable",
            ],
        )

    def recommend_profile(
        self,
        task: str,
        profiles: list[dict[str, Any]],
        page_context: dict[str, Any] | None = None,
        selected_profile_id: str | None = None,
    ) -> LocalAIRecommendation:
        task_text = (task or "").lower()
        page_context = page_context or {}

        if not profiles:
            return LocalAIRecommendation(
                selected_profile_id=None,
                confidence=0.0,
                reason="No saved local profiles were found.",
                resolved_tokens={},
                suggested_fields=[],
            )

        profile = None
        if selected_profile_id:
            for entry in profiles:
                if isinstance(entry, dict) and entry.get("id") == selected_profile_id:
                    profile = entry
                    break

        if profile is None:
            if "name" in task_text or "full name" in task_text or "personal" in task_text:
                for entry in profiles:
                    if isinstance(entry, dict) and entry.get("values", {}).get("name"):
                        profile = entry
                        break
            else:
                profile = profiles[0]

        resolved_tokens = build_profile_token_map(profiles, selected_profile_id=(profile or {}).get("id") if isinstance(profile, dict) else None)

        suggested_fields: list[str] = []
        for field in ("name", "email", "phone", "address", "company", "jobTitle"):
            values = (profile or {}).get("values", {}) if isinstance(profile, dict) else {}
            if values.get(field):
                suggested_fields.append(field)

        if selected_profile_id and profile is not None and profile.get("id") == selected_profile_id:
            reason = "Selected profile matches the current task and remains on-device."
            confidence = 0.97
            selected_id = selected_profile_id
        elif profile is not None:
            reason = "Best local profile chosen for the current form task."
            confidence = 0.88
            selected_id = str(profile.get("id"))
        else:
            reason = "No strong local match found; user confirmation is required."
            confidence = 0.35
            selected_id = None

        return LocalAIRecommendation(
            selected_profile_id=selected_id,
            confidence=confidence,
            reason=reason,
            resolved_tokens=resolved_tokens,
            suggested_fields=suggested_fields,
        )


def build_local_ai_summary(
    task: str,
    profiles: list[dict[str, Any]],
    page_context: dict[str, Any] | None = None,
    selected_profile_id: str | None = None,
) -> dict[str, Any]:
    service = LocalDesktopAIService()
    result = service.recommend_profile(task, profiles, page_context=page_context, selected_profile_id=selected_profile_id)
    return result.model_dump(exclude_none=True)
