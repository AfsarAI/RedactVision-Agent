import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from redactvision_server.local_profile_service import (
    LocalProfileAssistant,
    ProfileRequest,
    build_profile_token_map,
)


def test_build_profile_token_map_uses_tokens_and_preserves_selection():
    profiles = [
        {"id": "p1", "label": "Shrijal Gupta", "values": {"name": "Shrijal Gupta", "email": "shrijal@gmail.com"}},
        {"id": "p2", "label": "Afsar", "values": {"name": "Afsar", "email": "afsar@example.com"}},
    ]

    token_map = build_profile_token_map(profiles, selected_profile_id="p1")
    assert token_map["[PROFILE:name]"] == "Shrijal Gupta"
    assert token_map["[PROFILE:email]"] == "shrijal@gmail.com"


def test_local_profile_assistant_matches_selected_profile_for_name_field():
    assistant = LocalProfileAssistant()
    profiles = [
        {"id": "p1", "label": "Shrijal Gupta", "values": {"name": "Shrijal Gupta", "email": "shrijal@gmail.com"}},
        {"id": "p2", "label": "Afsar", "values": {"name": "Afsar", "email": "afsar@example.com"}},
    ]

    result = assistant.match_profile(
        profiles,
        field="name",
        observed_value="Shrijal Gupta",
        selected_profile_id="p1",
    )

    assert result["selected_profile_id"] == "p1"
    assert result["matches"] == ["p1"]
    assert result["resolved_value"] == "Shrijal Gupta"


def test_local_profile_assistant_handles_multiple_matches_without_guessing():
    assistant = LocalProfileAssistant()
    profiles = [
        {"id": "p1", "label": "Afsar Singh", "values": {"name": "Afsar", "email": "afsar1@example.com"}},
        {"id": "p2", "label": "Afsar Kumar", "values": {"name": "Afsar", "email": "afsar2@example.com"}},
    ]

    result = assistant.match_profile(
        profiles,
        field="name",
        observed_value="Afsar",
    )

    assert result["selected_profile_id"] is None
    assert result["matches"] == ["p1", "p2"]
    assert result["resolved_value"] is None


def test_profile_request_model_accepts_token_map_payload():
    payload = ProfileRequest(
        task="Fill the application form",
        page_context={"title": "Application form"},
        profile_candidates=[{"id": "p1", "label": "Shrijal Gupta", "values": {"name": "Shrijal Gupta"}}],
        token_map={"[PROFILE:name]": "Shrijal Gupta"},
    )

    assert payload.token_map["[PROFILE:name]"] == "Shrijal Gupta"
    assert payload.task == "Fill the application form"
