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
    SELECT = "select"
    NAVIGATE = "navigate"
    OPEN_TAB = "open_tab"
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
    url: Optional[str] = ""
    title: Optional[str] = ""
    elements: list = Field(default_factory=list, description="Sanitized DOM elements with tokens")
    prompt: Optional[str] = Field(None, description="User's natural language task")
    timestamp: Optional[float] = Field(0.0, description="Unix timestamp of capture")


class PlanRequest(BaseModel):
    """Body for POST /llm/plan — same shape as SanitizedEvent plus optional history."""
    url: Optional[str] = ""
    title: Optional[str] = ""
    elements: Optional[list] = Field(default_factory=list)
    prompt: Optional[str] = ""
    history: Optional[list] = Field(default_factory=list)
    timestamp: Optional[float] = None


class PlanResponse(BaseModel):
    action: dict = Field(..., description="Structured LLM action")
    source: str = Field(..., description="Which backend produced this (server-llm / mock / fallback)")
    provider: Optional[str] = Field(
        None,
        description="Display label of the LLM provider that actually answered (e.g. 'Groq', 'Gemini').",
    )
    model: Optional[str] = Field(
        None,
        description="Specific model slug that answered (e.g. 'llama-3.3-70b-versatile').",
    )


class VisualGroundRequest(BaseModel):
    image: str = Field(..., description="Base64 or data URL screenshot of the viewport")
    target_description: str = Field(..., description="Natural language description of the target element")
    viewport: Optional[dict] = None


class VisualGroundResponse(BaseModel):
    found: bool = True
    point: Optional[list[int]] = None  # [x, y] on 0-1000 scale
    box_2d: Optional[list[int]] = None  # [ymin, xmin, ymax, xmax]
    description: Optional[str] = None


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
