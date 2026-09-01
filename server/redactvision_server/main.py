"""
RedactVision Agent - FastAPI Server

Phase 7: Secure Client/Server Transport

Privacy contract:
- Server NEVER receives token maps
- Server NEVER receives raw PII
- Server only receives sanitized DOM with semantic tokens
- Server returns structured actions (client validates before execution)

Run with:
    cd server && uvicorn redactvision_server.main:app --reload --port 8001

Environment variables (.env) are loaded automatically from the project
root, regardless of where uvicorn was started from.
"""

import logging
import os
import re
import time
from pathlib import Path
from typing import Optional

# Load .env BEFORE importing any module that reads environment variables.
# We look for .env in the project root (one directory up from this file's
# package: server/redactvision_server/main.py → ../../.env).
try:
    from dotenv import load_dotenv  # python-dotenv (declared in pyproject)

    _PROJECT_ROOT = Path(__file__).resolve().parents[2]
    _ENV_PATH = _PROJECT_ROOT / ".env"
    if _ENV_PATH.exists():
        load_dotenv(_ENV_PATH, override=False)
        # Surface the discovery in the startup logs so users can see
        # which file the server picked up.
        logging.getLogger("redactvision_server").info(
            "Loaded environment from %s", _ENV_PATH
        )
    else:
        logging.getLogger("redactvision_server").info(
            "No .env found at %s — relying on OS environment", _ENV_PATH
        )
except ImportError:
    # python-dotenv not installed; fall back to OS env silently.
    pass

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .types import (
    SanitizedEvent,
    PlanRequest,
    PlanResponse,
    VisualGroundRequest,
    VisualGroundResponse,
    ServerAction,
    ServerMessage,
    ActionType,
    ConnectionStatus,
)
from .mock_agent import validate_action_request  # privacy validator; the rule-based mock agent is no longer used as a planner
from .llm import (
    plan_with_llm,
    visual_ground_with_vlm,
    health as llm_health,
    is_configured as llm_configured,
    validate_action_shape as llm_validate_action_shape,
)
from .providers import PROVIDERS


# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("redactvision_server")

# Create FastAPI app
app = FastAPI(
    title="RedactVision Agent Server",
    description="Privacy-preserving browser agent server with secure transport",
    version="0.1.0",
)

# CORS - restrict to localhost for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:*", "chrome-extension://*"],
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# WebSocket connection manager
class ConnectionManager:
    """Manages active WebSocket connections."""

    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)
        logger.info(f"Client connected. Active: {len(self.active_connections)}")

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)
        logger.info(f"Client disconnected. Active: {len(self.active_connections)}")

    async def send_message(self, websocket: WebSocket, message: ServerMessage):
        await websocket.send_json(message.model_dump(exclude_none=True))


manager = ConnectionManager()


@app.on_event("startup")
async def startup_list_providers() -> None:
    """
    On startup, list the configured providers and their model slugs.
    No live model discovery is performed — provider model slugs are
    pinned in providers.py and validated at call time. This keeps
    startup fast and avoids probing the network before the first
    user request.
    """
    if not llm_configured():
        logger.info("No LLM providers configured at startup.")
        return
    configured = [
        {"name": p.name, "models": p.models()}
        for p in PROVIDERS if p.available()
    ]
    logger.info("Configured LLM providers: %s", configured)


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "service": "RedactVision Agent Server",
        "version": "0.1.0",
        "status": "running",
        "privacy": "token_map_never_received",
    }


@app.get("/health")
async def health():
    """Health check for monitoring."""
    return {
        "status": "healthy",
        "timestamp": time.time(),
        "connections": len(manager.active_connections),
    }


@app.get("/privacy-status")
async def privacy_status():
    """
    Document the privacy contract.
    This endpoint should be called by the client during onboarding.
    """
    return {
        "server_receives": [
            "sanitized_page_url",
            "page_title",
            "sanitized_dom_elements (with tokens like [EMAIL_01])",
            "user_task_prompt",
            "capture_timestamp",
        ],
        "server_never_receives": [
            "local_token_map",
            "original_sensitive_values",
            "raw_emails (rahul@gmail.com)",
            "raw_phones (9876543210)",
            "raw_passwords",
            "raw_names",
            "credit_card_numbers",
            "any_pii_that_client_detected",
        ],
        "server_returns": [
            "structured_action (click/type/scroll/navigate/wait)",
            "target_selector",
            "confidence_score",
            "optional_token_reference (for TYPE actions)",
        ],
        "security": [
            "input_validation_on_all_requests",
            "token_map_rejected_if_present",
            "raw_pii_rejected_if_detected",
            "websocket_authentication_future",
        ],
    }


@app.websocket("/ws/agent")
async def websocket_endpoint(websocket: WebSocket):
    """
    Main WebSocket endpoint for agent communication.

    Protocol:
    1. Client sends SanitizedEvent (sanitized DOM + user prompt)
    2. Server validates privacy contract
    3. Server runs mock agent reasoning
    4. Server returns ServerAction
    5. Client validates action before execution

    Privacy: Server NEVER receives token_map or raw PII.
    """
    await manager.connect(websocket)

    try:
        # Send connection acknowledgment
        await manager.send_message(
            websocket,
            ServerMessage(
                type="status",
                data={"connected": True, "message": "Connected to RedactVision Agent server"}
            )
        )

        # Main message loop
        while True:
            # Receive sanitized event from client
            raw_data = await websocket.receive_json()
            logger.info(f"Received event from client")

            # Parse event
            try:
                event = SanitizedEvent(**raw_data)
            except Exception as e:
                logger.error(f"Failed to parse event: {e}")
                await manager.send_message(
                    websocket,
                    ServerMessage(
                        type="error",
                        error=f"Invalid event format: {str(e)}"
                    )
                )
                continue

            # Validate privacy contract
            is_valid, error = validate_action_request(event)
            if not is_valid:
                logger.warning(f"Privacy violation detected: {error}")
                await manager.send_message(
                    websocket,
                    ServerMessage(
                        type="error",
                        error=f"Privacy violation: {error}"
                    )
                )
                continue

            # Run mock agent reasoning
            try:
                action = determine_action(event)
                logger.info(f"Mock agent determined action: {action.action} on {action.target}")

                # Send action to client
                await manager.send_message(
                    websocket,
                    ServerMessage(
                        type="action",
                        data=action.model_dump(exclude_none=True)
                    )
                )

            except Exception as e:
                logger.error(f"Agent reasoning failed: {e}")
                await manager.send_message(
                    websocket,
                    ServerMessage(
                        type="error",
                        error=f"Agent reasoning failed: {str(e)}"
                    )
                )

    except WebSocketDisconnect:
        manager.disconnect(websocket)
        logger.info("Client disconnected")
    except Exception as e:
        logger.error(f"WebSocket error: {e}")
        manager.disconnect(websocket)


# REST fallback endpoints for non-WebSocket clients
@app.post("/api/analyze")
async def analyze_page(event: SanitizedEvent):
    """
    REST endpoint for page analysis.
    For clients that cannot use WebSocket.
    """
    is_valid, error = validate_action_request(event)
    if not is_valid:
        raise HTTPException(status_code=400, detail=f"Privacy violation: {error}")

    action = determine_action(event)
    return {"action": action.model_dump(exclude_none=True)}


# ===================================================================
# LLM-backed planner endpoints
# ===================================================================

@app.get("/llm/health")
async def llm_health_endpoint():
    """Report LLM backend configuration status."""
    return llm_health()


@app.post("/llm/discover")
async def llm_discover_endpoint():
    """
    Return the configured providers and their pinned model slugs.
    No live discovery — model slugs are validated at call time.
    """
    return {
        "ok": True,
        "providers": [
            {"name": p.name, "models": p.models(), "available": p.available()}
            for p in PROVIDERS
        ],
    }


@app.post("/llm/plan")
async def llm_plan(request: PlanRequest):
    """
    Plan one action using the configured LLM.

    Request body:
      - url, title, elements: sanitized page context
      - prompt: user's natural language task
      - history: optional list of previous actions (for multi-iteration)

    Response:
      - action: structured action dict matching the LLM action schema
      - source: "server-llm" or "fallback-mock"
      - provider: display name of the LLM provider that answered

    Privacy: re-runs validate_action_request to ensure no raw PII slips in.

    Architectural note: the server is the SOLE planner. When no LLM is
    configured, the server does NOT silently invent a hardcoded rule
    agent — it returns a 503 with an explicit `code: "llm_not_configured"`
    so the client can surface a clear "Agent offline" state to the user.
    """
    # Re-package as a SanitizedEvent so the privacy check works unchanged
    fake_event = SanitizedEvent(
        url=request.url or "",
        title=request.title or "",
        elements=request.elements or [],
        prompt=request.prompt or "",
        timestamp=request.timestamp or 0.0,
    )
    # Defense-in-depth sanitization: ensure no raw PII reaches the LLM
    for element in (fake_event.elements or []):
        if isinstance(element, dict):
            for field in ["value", "text", "placeholder", "ariaLabel"]:
                v = element.get(field)
                if isinstance(v, str) and v:
                    v_clean = re.sub(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b", "[EMAIL_01]", v)
                    v_clean = re.sub(r"\b(?:\+91[\s-]?)?[6-9]\d{9}\b", "[PHONE_01]", v_clean)
                    v_clean = re.sub(r"\b(?:\+?1[\s-]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b", "[PHONE_01]", v_clean)
                    element[field] = v_clean

    if not llm_configured():
        logger.warning(
            "LLM not configured — refusing to invent an action via hardcoded rules. "
            "Set at least one provider key in .env (see .env.example)."
        )
        return JSONResponse(
            status_code=503,
            content={
                "error": "llm_not_configured",
                "message": (
                    "No LLM provider is configured on the server. The RedactVision "
                    "Agent requires a server-side LLM to interpret natural-language "
                    "tasks. Configure at least one provider in the server's .env file."
                ),
                "code": "llm_not_configured",
            },
        )

    try:
        raw, provider_name = plan_with_llm(fake_event, history=request.history)
        validated = llm_validate_action_shape(raw)
        return PlanResponse(action=validated, source="server-llm", provider=provider_name)
    except (RuntimeError, ValueError) as e:
        logger.error("LLM plan failed: %s", e)
        # On LLM failure, do NOT silently substitute a hardcoded mock
        # agent. Return a clear error so the client knows the planner
        # is currently unavailable.
        return JSONResponse(
            status_code=502,
            content={
                "error": "llm_unavailable",
                "message": (
                    "The server's LLM provider chain failed to produce a valid "
                    "action. The agent cannot safely guess what to do."
                ),
                "code": "llm_unavailable",
                "detail": str(e),
            },
        )


@app.post("/llm/visual-ground")
async def llm_visual_ground(request: VisualGroundRequest):
    """
    Multimodal Vision-Language Fallback endpoint.
    Locates an element visually from a viewport screenshot when standard DOM lookup fails.
    Returns normalized [0-1000] coordinates: { "found": bool, "point": [x, y], "box_2d": [...] }
    """
    if not llm_configured():
        return VisualGroundResponse(found=False)

    try:
        result = visual_ground_with_vlm(request.image, request.target_description)
        found = bool(result.get("found", False))
        point = result.get("point") if found and isinstance(result.get("point"), list) else None
        box_2d = result.get("box_2d") if found and isinstance(result.get("box_2d"), list) else None
        desc = result.get("description")
        return VisualGroundResponse(found=found, point=point, box_2d=box_2d, description=desc)
    except Exception as e:
        logger.warning("Visual grounding request error: %s", e)
        return VisualGroundResponse(found=False)


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """Global error handler."""
    logger.error(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": str(exc)}
    )


def _free_port(port: int = 8001) -> None:
    """Safely terminate any orphaned process holding the target port before starting."""
    import subprocess
    import os
    try:
        out = subprocess.check_output(["lsof", "-ti", f":{port}"], text=True, stderr=subprocess.DEVNULL).strip()
        if out:
            current_pid = str(os.getpid())
            for pid in out.split():
                if pid != current_pid:
                    subprocess.run(["kill", "-9", pid], check=False, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            time.sleep(0.6)
    except Exception:
        pass


def main():
    """Run the server."""
    import uvicorn
    _free_port(8001)
    uvicorn.run(
        "redactvision_server.main:app",
        host="127.0.0.1",
        port=8001,
        reload=True,
    )


def dev_main():
    """Development entrypoint."""
    main()


if __name__ == "__main__":
    main()
