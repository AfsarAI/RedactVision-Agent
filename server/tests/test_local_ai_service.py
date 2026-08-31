import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from redactvision_server.local_ai_service import LocalDesktopAIService


def test_local_ai_service_recommends_selected_profile_for_application_form():
    service = LocalDesktopAIService()
    profiles = [
        {"id": "p1", "label": "Shrijal Gupta", "values": {"name": "Shrijal Gupta", "email": "shrijal@gmail.com", "phone": "+91 98765 43210"}},
        {"id": "p2", "label": "Afsar", "values": {"name": "Afsar", "email": "afsar@example.com", "phone": "+91 91234 56789"}},
    ]

    result = service.recommend_profile("Fill the job application form with my details", profiles, selected_profile_id="p1")
    assert result.selected_profile_id == "p1"
    assert result.confidence >= 0.9
    assert result.resolved_tokens["[PROFILE:name]"] == "Shrijal Gupta"
    assert result.resolved_tokens["[PROFILE:email]"] == "shrijal@gmail.com"


def test_local_ai_service_falls_back_to_best_available_profile_when_no_selection():
    service = LocalDesktopAIService()
    profiles = [
        {"id": "p1", "label": "Shrijal Gupta", "values": {"name": "Shrijal Gupta", "email": "shrijal@gmail.com"}},
        {"id": "p2", "label": "Afsar", "values": {"name": "Afsar", "email": "afsar@example.com"}},
    ]

    result = service.recommend_profile("Apply for a job", profiles)
    assert result.selected_profile_id == "p1"
    assert result.confidence >= 0.8


def test_local_ai_service_health_is_explicitly_local_only():
    service = LocalDesktopAIService()
    health = service.health()
    assert health.local_only is True
    assert health.lightweight is True
    assert "on-device" in " ".join(health.notes).lower()
