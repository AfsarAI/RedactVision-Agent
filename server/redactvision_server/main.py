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
"""

import asyncio
import logging
import time
from typing import Optional

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .types import (
    SanitizedEvent,
    ServerAction,
    ServerMessage,
    ActionType,
    ConnectionStatus,
)
from .mock_agent import determine_action, validate_action_request


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


@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    """Global error handler."""
    logger.error(f"Unhandled exception: {exc}")
    return JSONResponse(
        status_code=500,
        content={"error": "Internal server error", "detail": str(exc)}
    )


def main():
    """Run the server."""
    import uvicorn
    uvicorn.run(
        "redactvision_server.main:app",
        host="127.0.0.1",
        port=8001,
        reload=True,
    )


if __name__ == "__main__":
    main()
