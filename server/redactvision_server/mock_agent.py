"""
Mock agent for Phase 7 - simulates server-side reasoning.

Privacy contract: This module NEVER receives or stores:
- raw token maps
- original sensitive values
- passwords, emails, phone numbers, names

It only receives sanitized DOM context with semantic tokens.
"""

import re
import random
from typing import Optional
from .types import SanitizedEvent, ServerAction, ActionType


# Token type patterns - server knows tokens exist but NOT original values
TOKEN_PATTERNS = {
    "EMAIL": re.compile(r"\[EMAIL_\d+\]"),
    "PHONE": re.compile(r"\[PHONE_\d+\]"),
    "PASSWORD": re.compile(r"\[PASSWORD_\d+\]"),
    "PERSON": re.compile(r"\[PERSON_\d+\]"),
    "CARD": re.compile(r"\[CARD_\d+\]"),
    "AADHAAR": re.compile(r"\[AADHAAR_\d+\]"),
}

# Supported action keywords
ACTION_KEYWORDS = {
    "click": ["click", "press", "submit", "select", "choose", "tap"],
    "type": ["fill", "type", "enter", "write", "input", "set"],
    "scroll": ["scroll", "scroll down", "scroll up"],
    "navigate": ["go to", "navigate to", "visit", "open", "browse to"],
    "wait": ["wait", "pause", "delay", "sleep"],
}


def _extract_keywords(prompt: str) -> list[str]:
    """Extract action-related keywords from prompt."""
    prompt_lower = prompt.lower()
    keywords = []
    for action, words in ACTION_KEYWORDS.items():
        for word in words:
            if word in prompt_lower:
                keywords.append(action)
                break
    return keywords


def _find_element_by_semantics(
    elements: list[dict],
    action: str,
    prompt: str
) -> Optional[dict]:
    """
    Find target element based on semantic analysis of sanitized context.

    Server sees tokens like [EMAIL_01] but NOT the original email.
    """
    prompt_lower = prompt.lower()

    # Common interactive element keywords
    field_keywords = {
        "email": ["email", "mail", "e-mail"],
        "phone": ["phone", "mobile", "tel", "cell"],
        "password": ["password", "passcode", "pass"],
        "name": ["name", "full-name", "fullname", "first-name", "last-name"],
        "submit": ["submit", "send", "register", "signup", "sign-up", "create"],
        "cancel": ["cancel", "abort", "back", "close"],
        "search": ["search", "find", "query"],
        "message": ["message", "comment", "feedback", "note"],
    }

    for element in elements:
        tag = element.get("tag", "").lower()
        element_id = (element.get("id") or "").lower()
        element_name = (element.get("name") or "").lower()
        element_type = (element.get("type") or "").lower()
        element_text = (element.get("text") or "").lower()

        # Skip form elements for click actions (only match actual buttons)
        if action == "click" and tag != "button":
            continue

        # Match by ID or name patterns
        for field, keywords in field_keywords.items():
            if field == "email" and ("email" in element_id or "email" in element_name):
                if action == "type":
                    return element
            elif field == "phone" and ("phone" in element_id or "tel" in element_id):
                if action == "type":
                    return element
            elif field == "password" and ("password" in element_id or element_type == "password"):
                if action == "type":
                    return element
            elif field == "name" and ("name" in element_id or "full-name" in element_id):
                if action == "type":
                    return element
            elif field == "submit":
                if "submit" in element_id or "btn" in element_id:
                    if action == "click":
                        return element
            elif field == "cancel":
                if "cancel" in element_id or "cancel" in element_text:
                    if action == "click":
                        return element

    return None


def determine_action(event: SanitizedEvent) -> ServerAction:
    """
    Mock agent reasoning: determine next action based on sanitized context.

    This is a simplified mock - real implementation would use VLM/LLM.
    Server receives:
    - URL (sanitized)
    - Page title (sanitized)
    - Elements with semantic tokens ([EMAIL_01], [PHONE_01], etc.)
    - User prompt

    Server NEVER receives:
    - Token map
    - Original values (rahul@gmail.com stays hidden)
    - Raw passwords
    """
    prompt = event.prompt or ""
    prompt_lower = prompt.lower()
    elements = event.elements or []

    # Default fallback action
    default_action = ServerAction(
        action=ActionType.CLICK,
        target="#submit",
        confidence=0.85,
        metadata={"reason": "default_fallback"}
    )

    if not elements:
        return default_action

    # Detect action type from prompt
    detected_actions = _extract_keywords(prompt)
    action = detected_actions[0] if detected_actions else "click"

    # Find target element
    target_element = _find_element_by_semantics(elements, action, prompt)

    if target_element:
        selector = target_element.get("selector", target_element.get("id", ""))
        if not selector:
            selector = target_element.get("id", "")

        if action == "click":
            return ServerAction(
                action=ActionType.CLICK,
                target=selector,
                confidence=0.95,
                metadata={
                    "element_tag": target_element.get("tag"),
                    "reason": "element_matched"
                }
            )
        elif action == "type":
            # For TYPE actions, if prompt mentions a token type, use the token
            value = None
            for token_type, pattern in TOKEN_PATTERNS.items():
                if token_type.lower() in prompt_lower:
                    # Server returns token - client resolves it locally
                    value = f"[{token_type}_01]"
                    break

            if not value and "name" in prompt_lower:
                value = "[PERSON_01]"
            elif not value and "email" in prompt_lower:
                value = "[EMAIL_01]"
            elif not value and "phone" in prompt_lower:
                value = "[PHONE_01]"

            return ServerAction(
                action=ActionType.TYPE,
                target=selector,
                confidence=0.92,
                value=value or "test_value",
                metadata={
                    "element_tag": target_element.get("tag"),
                    "note": "value_is_token_client_resolves"
                }
            )

    # Fallback: look for submit button
    for element in elements:
        element_id = (element.get("id") or "").lower()
        tag = (element.get("tag") or "").lower()
        # Only match actual button elements with submit in id
        if tag == "button" and ("submit" in element_id or "btn" in element_id):
            return ServerAction(
                action=ActionType.CLICK,
                target=element.get("selector", element.get("id", "")),
                confidence=0.90,
                metadata={"reason": "fallback_submit_button"}
            )

    return default_action


def validate_action_request(event: SanitizedEvent) -> tuple[bool, Optional[str]]:
    """
    Validate that the incoming request follows privacy contract.

    Returns (is_valid, error_message).
    """
    # Check that no token maps are being sent
    if hasattr(event, "token_map") or (hasattr(event, "metadata") and event.metadata and "token_map" in str(event.metadata)):
        return False, "Privacy violation: token_map should not be sent to server"

    # Check that no obvious raw PII is in elements
    for element in (event.elements or []):
        for field in ["value", "text"]:
            value = element.get(field, "")
            if value and isinstance(value, str):
                # Basic heuristic check - server should not receive raw emails/phones
                if re.match(r".*@.*\..*", value) and "[EMAIL" not in value:
                    return False, f"Privacy violation: possible raw email in {field}"
                if re.match(r"^\+?[\d\s-]{10,}$", value) and "[PHONE" not in value:
                    return False, f"Privacy violation: possible raw phone in {field}"

    return True, None
