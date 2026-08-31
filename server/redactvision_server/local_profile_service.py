"""Local profile service for on-device personal data matching.

This service implements the lightweight local identity layer described in the
project requirements:
- save multiple profiles locally
- match a field against known profile values
- resolve selected profile values into token-safe placeholders
- keep the original profile values on-device and out of the server payload

The module intentionally stays small and deterministic so it can run on any
mainstream laptop without extra infrastructure.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any

from pydantic import BaseModel, Field


FIELD_ALIASES = {
    "name": "name",
    "full_name": "name",
    "full-name": "name",
    "email": "email",
    "phone": "phone",
    "mobile": "phone",
    "address": "address",
    "company": "company",
    "job_title": "jobTitle",
    "job-title": "jobTitle",
    "password": "password",
}


def _normalize_value(value: Any) -> str:
    if value is None:
        return ""
    return str(value).strip().lower()


def _profile_values_for(profile: dict[str, Any]) -> dict[str, Any]:
    values = profile.get("values") if isinstance(profile, dict) else {}
    if not isinstance(values, dict):
        return {}
    return values


def build_profile_token_map(
    profiles: list[dict[str, Any]],
    selected_profile_id: str | None = None,
) -> dict[str, str]:
    """Build a local token map using the selected profile as the canonical source.

    Example:
        {"[PROFILE:name]": "Shrijal Gupta", "[PROFILE:email]": "shrijal@gmail.com"}
    """
    token_map: dict[str, str] = {}
    selected_profile = None
    if selected_profile_id:
        for profile in profiles:
            if isinstance(profile, dict) and profile.get("id") == selected_profile_id:
                selected_profile = profile
                break

    if not selected_profile:
        selected_profile = profiles[0] if profiles else None

    if not isinstance(selected_profile, dict):
        return token_map

    values = _profile_values_for(selected_profile)
    for field in ("name", "email", "phone", "address", "company", "jobTitle", "password"):
        value = values.get(field)
        if value is not None and str(value).strip():
            token_map[f"[PROFILE:{field}]"] = str(value).strip()
    return token_map


class ProfileRequest(BaseModel):
    task: str = Field(..., description="User task or form intent")
    page_context: dict[str, Any] = Field(default_factory=dict)
    profile_candidates: list[dict[str, Any]] = Field(default_factory=list)
    token_map: dict[str, str] = Field(default_factory=dict)


class LocalProfileAssistant:
    """Small, deterministic matching helper for local profile selection."""

    def match_profile(
        self,
        profiles: list[dict[str, Any]],
        field: str,
        observed_value: str,
        selected_profile_id: str | None = None,
    ) -> dict[str, Any]:
        normalized_field = FIELD_ALIASES.get(field.lower(), field.lower())
        normalized_value = _normalize_value(observed_value)

        matches: list[str] = []
        for profile in profiles:
            if not isinstance(profile, dict):
                continue
            profile_values = _profile_values_for(profile)
            candidate = profile_values.get(normalized_field)
            if candidate is not None and _normalize_value(candidate) == normalized_value:
                matches.append(str(profile.get("id", "")))

        if selected_profile_id and selected_profile_id in matches:
            resolved_value = self._get_selected_field_value(profiles, selected_profile_id, normalized_field)
            return {
                "selected_profile_id": selected_profile_id,
                "matches": matches,
                "resolved_value": resolved_value,
            }

        if len(matches) == 1:
            selected = matches[0]
            return {
                "selected_profile_id": selected,
                "matches": matches,
                "resolved_value": self._get_selected_field_value(profiles, selected, normalized_field),
            }

        if len(matches) > 1:
            return {
                "selected_profile_id": None,
                "matches": matches,
                "resolved_value": None,
            }

        if selected_profile_id:
            resolved_value = self._get_selected_field_value(profiles, selected_profile_id, normalized_field)
            return {
                "selected_profile_id": selected_profile_id,
                "matches": [],
                "resolved_value": resolved_value,
            }

        return {
            "selected_profile_id": None,
            "matches": [],
            "resolved_value": None,
        }

    def select_profile_for_task(
        self,
        profiles: list[dict[str, Any]],
        task: str,
        selected_profile_id: str | None = None,
    ) -> dict[str, Any]:
        """Return the selected or best-matching profile for a task."""
        if selected_profile_id:
            for profile in profiles:
                if isinstance(profile, dict) and profile.get("id") == selected_profile_id:
                    return {"profile_id": selected_profile_id, "profile": deepcopy(profile)}

        if profiles:
            return {"profile_id": profiles[0].get("id"), "profile": deepcopy(profiles[0])}

        return {"profile_id": None, "profile": {}}

    def _get_selected_field_value(
        self,
        profiles: list[dict[str, Any]],
        profile_id: str | None,
        field: str,
    ) -> Any:
        if not profile_id:
            return None
        for profile in profiles:
            if not isinstance(profile, dict):
                continue
            if str(profile.get("id")) != str(profile_id):
                continue
            values = _profile_values_for(profile)
            return values.get(field)
        return None
