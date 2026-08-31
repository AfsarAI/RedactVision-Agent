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

    def _scan_string(field_name: str, value: object) -> Optional[str]:
        if not isinstance(value, str):
            return None
        if not value.strip():
            return None
        if "[EMAIL_" in value or "[PHONE_" in value or "[PERSON_" in value or "[PASSWORD_" in value:
            return None
        if re.search(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}", value):
            return f"Privacy violation: possible raw email in {field_name}"
        # Require 10-15 digits for actual phone numbers (optionally with + or standard dashes/spaces),
        # not matching arbitrary numbers/years/counters like "2026" or "123".
        if re.search(r"(?:\+?\d{1,3}[-.\s]?)?[6-9]\d{9}\b", value) or re.search(r"\b(?:\+?\d{1,3}[-.\s]?)?\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b", value):
            return f"Privacy violation: possible raw phone in {field_name}"
        if re.search(r"(?i)\b(?:my\s+name\s+is|i\s+am|full\s+name\s+is)\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+", value):
            return f"Privacy violation: possible raw person name in {field_name}"
        return None

    for field_name, value in {
        "prompt": getattr(event, "prompt", None),
    }.items():
        reason = _scan_string(field_name, value)
        if reason:
            return False, reason

    for element in (event.elements or []):
        if not isinstance(element, dict):
            continue
        for field in ["value", "text", "placeholder", "ariaLabel"]:
            reason = _scan_string(f"{field} in element", element.get(field, ""))
            if reason:
                return False, reason

    return True, None
