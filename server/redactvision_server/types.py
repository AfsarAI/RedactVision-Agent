"""
Phase 7: API contract for secure client/server transport.

Server receives sanitized payloads NEVER containing:
- raw token map
- original sensitive values
- raw passwords, emails, phones, names, credit cards

Server returns structured actions ONLY:
- action type (CLICK, TYPE, SCROLL, NAVIGATE, WAIT)
- target selector/id
- confidence score
"""

from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


class ActionType(str, Enum):
    """Browser action types that server may propose (client validates)."""
    CLICK = "click"
    TYPE = "type"
    SCROLL = "scroll"
    NAVIGATE = "navigate"
    WAIT = "wait"


class ServerAction(BaseModel):
    """
    Structured action returned by the server.

    IMPORTANT: For TYPE actions that need tokenized values,
    the server returns the token (e.g. [EMAIL_01]).
    The client resolves it locally using its local token map.
    """
    action: ActionType
    target: str = Field(..., description="CSS selector or element identifier")
    confidence: float = Field(..., ge=0.0, le=1.0, description="Confidence score 0-1")
    value: Optional[str] = Field(None, description="Optional value (may be token like [EMAIL_01])")
    metadata: Optional[dict] = Field(None, description="Optional additional metadata")


class SanitizedEvent(BaseModel):
    """
    Payload sent FROM client TO server.

    Contains ONLY sanitized information:
    - page URL (sanitized path, no PII in params)
    - element selectors (never raw values)
    - semantic tokens (e.g. [EMAIL_01])
    - safe text (labels, static content)
    """
    url: str
    title: str
    elements: list = Field(..., description="Sanitized DOM elements with tokens")
    prompt: Optional[str] = Field(None, description="User's natural language task")
    timestamp: float = Field(..., description="Unix timestamp of capture")


class ConnectionStatus(BaseModel):
    """Server connection status update to client."""
    connected: bool
    message: Optional[str] = None


class ServerMessage(BaseModel):
    """
    Wrapper for all server messages.
    Server responses never contain original PII or token map.
    """
    type: str = Field(..., description="Message type: 'action', 'status', 'error'")
    data: Optional[dict] = None
    error: Optional[str] = None