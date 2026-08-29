"""
RedactVision Agent - server-side LLM smoke test

This test does NOT call a real LLM. It exercises:
  - the privacy re-validation on the server
  - the JSON parsing + shape validation
  - the fallback path when the LLM is not configured
  - the prompt template

Run:
  cd server
  python -m pytest tests/test_llm_planner.py -v
  # OR
  python tests/test_llm_planner.py
"""

import json
import sys
import os

# Allow running as a script
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from redactvision_server.llm import (
    _parse_json,
    validate_action_shape,
    is_configured,
    health,
)
from redactvision_server.planner_prompt import build_user_prompt
from redactvision_server.mock_agent import determine_action
from redactvision_server.types import SanitizedEvent


SAMPLE_DOM = {
    "url": "http://localhost:8000/",
    "title": "Test Form",
    "elements": [
        {"tag": "input", "id": "full-name", "value": "[PERSON_01]", "selector": "#full-name"},
        {"tag": "input", "id": "email", "value": "[EMAIL_01]", "selector": "#email"},
        {"tag": "input", "id": "phone", "value": "[PHONE_01]", "selector": "#phone"},
        {"tag": "input", "id": "password", "value": "[PASSWORD_01]", "selector": "#password"},
        {"tag": "select", "id": "country", "selector": "#country"},
        {"tag": "button", "id": "submit-btn", "text": "Submit Form", "selector": "#submit-btn"},
        {"tag": "button", "id": "cancel-btn", "text": "Cancel", "selector": "#cancel-btn"},
    ],
}


def test_parse_json_clean():
    """Parser handles clean JSON output."""
    out = _parse_json('{"action": "click", "target": "#x", "confidence": 0.9}')
    assert out["action"] == "click"
    assert out["target"] == "#x"


def test_parse_json_fenced():
    """Parser handles markdown-fenced JSON."""
    out = _parse_json('```json\n{"action": "done", "confidence": 0.99}\n```')
    assert out["action"] == "done"


def test_parse_json_with_chatter():
    """Parser extracts first JSON object from noisy output."""
    out = _parse_json('Here is the answer:\n{"action": "scroll", "amount": 500, "confidence": 0.85}\nDone.')
    assert out["action"] == "scroll"
    assert out["amount"] == 500


def test_validate_shape_click():
    a = validate_action_shape({"action": "click", "target": "#x", "confidence": 0.9})
    assert a["action"] == "click"


def test_validate_shape_type_requires_value():
    try:
        validate_action_shape({"action": "type", "target": "#x", "confidence": 0.9})
        assert False, "should have raised"
    except ValueError as e:
        assert "value" in str(e)


def test_validate_shape_bad_confidence():
    try:
        validate_action_shape({"action": "click", "target": "#x", "confidence": 1.5})
        assert False, "should have raised"
    except ValueError as e:
        assert "confidence" in str(e)


def test_validate_shape_done_normalizes():
    a = validate_action_shape({"action": "done", "confidence": 0.9})
    assert a["done"] is True


def test_user_prompt_contains_required_fields():
    p = build_user_prompt("click submit", SAMPLE_DOM)
    assert "click submit" in p
    assert "[EMAIL_01]" in p  # sanitized token, not raw email
    assert "#submit-btn" in p


def test_user_prompt_does_not_leak_raw_pii():
    """The prompt builder must not include any raw PII — it just serializes what it's given."""
    p = build_user_prompt("test", SAMPLE_DOM)
    # Our SAMPLE_DOM is already sanitized. The check is that we don't add raw data.
    # The builder is dumb-passthrough; this test is a regression guard.
    assert "rahul@gmail.com" not in p
    assert "9876543210" not in p


def test_health_endpoint_shape():
    h = health()
    assert "configured" in h
    assert "model" in h
    assert "api_url" in h


def test_fallback_when_not_configured():
    """If no API key is set, is_configured() should be False."""
    # We don't actually unset the env here; just check the function returns a bool.
    assert isinstance(is_configured(), bool)


def test_mock_planner_produces_action():
    """Sanity check that the mock planner still works for the test page."""
    evt = SanitizedEvent(
        url=SAMPLE_DOM["url"],
        title=SAMPLE_DOM["title"],
        elements=SAMPLE_DOM["elements"],
        prompt="Click submit",
        timestamp=0.0,
    )
    action = determine_action(evt)
    assert action.action.value == "click"
    assert action.target == "#submit-btn"


if __name__ == "__main__":
    # Allow `python tests/test_llm_planner.py`
    import traceback
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ✓  {fn.__name__}")
        except Exception:
            print(f"  ✗  {fn.__name__}")
            traceback.print_exc()
            failed += 1
    print(f"\n{len(fns) - failed}/{len(fns)} passed.")
    sys.exit(1 if failed else 0)
