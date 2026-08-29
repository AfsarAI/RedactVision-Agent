# RedactVision Agent Server

Phase 7: Secure Client/Server Transport

## Quick Start

```bash
cd server

# Using the project venv
source ../.venv/bin/activate

# Run the server
uvicorn redactvision_server.main:app --reload --port 8001 --host 127.0.0.1
```

Or run directly:

```bash
cd server
python -m redactvision_server.main
```

## Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/` | GET | Health check |
| `/health` | GET | Detailed health status |
| `/privacy-status` | GET | Privacy contract documentation |
| `/ws/agent` | WS | WebSocket for agent communication |
| `/api/analyze` | POST | REST fallback for page analysis |

## Privacy Contract

### Server NEVER Receives
- ❌ Local token map
- ❌ Raw emails (rahul@gmail.com)
- ❌ Raw phones (9876543210)
- ❌ Raw passwords
- ❌ Raw names
- ❌ Credit card numbers
- ❌ Any PII the client detected

### Server Receives
- ✅ Sanitized page URL
- ✅ Page title
- ✅ DOM elements with semantic tokens ([EMAIL_01], [PHONE_01], etc.)
- ✅ User task prompt
- ✅ Capture timestamp

### Server Returns
- ✅ Structured action (click/type/scroll/navigate/wait)
- ✅ Target selector
- ✅ Confidence score
- ✅ Token references (for TYPE actions)

## WebSocket Protocol

1. Client connects to `/ws/agent`
2. Server sends `{ "type": "status", "data": { "connected": true } }`
3. Client sends sanitized event:
   ```json
   {
     "url": "https://example.com/form",
     "title": "Profile Form",
     "elements": [
       {
         "tag": "input",
         "id": "email",
         "value": "[EMAIL_01]",
         "selector": "#email"
       }
     ],
     "prompt": "Fill the email field and submit",
     "timestamp": 1234567890.123
   }
   ```
4. Server validates privacy contract
5. Server runs mock agent reasoning
6. Server returns action:
   ```json
   {
     "type": "action",
     "data": {
       "action": "type",
       "target": "#email",
       "confidence": 0.92,
       "value": "[EMAIL_01]"
     }
   }
   ```

## Mock Agent

The mock agent simulates reasoning over sanitized context:

- Analyzes element selectors and semantic tokens
- Matches user prompt keywords to action types
- Returns structured actions based on DOM context

Real implementation would use VLM/LLM for reasoning.

## Testing

```bash
# Start server
uvicorn redactvision_server.main:app --port 8001

# In another terminal, test with curl
curl http://127.0.0.1:8001/health

# Test privacy status
curl http://127.0.0.1:8001/privacy-status

# Test REST endpoint
curl -X POST http://127.0.0.1:8001/api/analyze \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "title": "Test Page",
    "elements": [{"tag": "button", "id": "submit", "selector": "#submit"}],
    "prompt": "Click submit",
    "timestamp": 1234567890
  }'
```
