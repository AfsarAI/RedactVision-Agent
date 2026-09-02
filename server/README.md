# RedactVision Reasoning Server

FastAPI-powered privacy-preserving reasoning gateway for the RedactVision browser agent. It processes sanitized DOM contexts, generates structured browser actions via a bounded multi-provider LLM chain, and enforces strict privacy boundaries.

---

## 🚀 Quick Start

### 1. Install Dependencies

```bash
cd server
pip install -e ".[dev]"
# Or from repository root: pip install -r requirements.txt
```

### 2. Configure Environment (`.env`)

Ensure API keys are set in `.env` at the project root:

```env
GROQ_API_KEY=gsk_...
OPENROUTER_API_KEY=sk-or-v1-...
OMNIROUTE_URL=http://localhost:20128/v1/chat/completions
```

### 3. Run the Server

```bash
start-server
# Or: uvicorn redactvision_server.main:app --reload --port 8001 --host 127.0.0.1
```

---

## 📡 Endpoints Reference

| Endpoint                 | Method | Purpose                                                      | Input / Output Schema                              |
| :----------------------- | :----: | :----------------------------------------------------------- | :------------------------------------------------- |
| **`/health`**            | `GET`  | Health check & active connection status                      | Returns `{"status": "healthy", ...}`               |
| **`/privacy-status`**    | `GET`  | Documents privacy guarantees and data boundary               | Returns allowable & forbidden payload specs        |
| **`/llm/plan`**          | `POST` | Core single-step autonomous browser planning                 | `PlanRequest` → `PlanResponse`                     |
| **`/llm/plan-smart`**    | `POST` | Think-Before-Acting multi-step planning with self-validation | `SmartPlanRequest` → `SmartPlanResponse`           |
| **`/llm/validate-step`** | `POST` | Sub-second DOM state evaluation against expected criteria    | `StepValidationRequest` → `StepValidationResponse` |
| **`/llm/visual-ground`** | `POST` | Multimodal VLM screenshot coordinate localization            | `VisualGroundRequest` → `VisualGroundResponse`     |
| **`/llm/health`**        | `GET`  | LLM provider availability & model statuses                   | Returns active provider chain state                |
| **`/ws/agent`**          |  `WS`  | Bidirectional WebSocket session stream                       | `SanitizedEvent` ↔ `ServerMessage`                 |

---

## 🔒 Privacy & Defense-in-Depth

### Server Contract

- **Never Receives**: Raw emails, phones, names, passwords, cards, or client-side token maps.
- **Receives**: Sanitized URLs, titles, element metadata with semantic tokens (`[PERSON_01]`, `[EMAIL_01]`, `[PROFILE:name]`).
- **Defense-in-Depth**: Automatically strips any remaining raw PII patterns before feeding reasoning prompts to LLM providers.
- **Returns**: Strict JSON action objects (`click`, `type`, `scroll`, `select`, `wait`, `navigate`, `open_tab`, `done`).

---

## ⚡ Multi-Provider LLM Hierarchy

```text
1. Groq (PRIMARY) ──────► 2. OpenRouter (SECONDARY) ──────► 3. OmniRoute (TERTIARY FALLBACK)
```

- **Groq (Primary)**: Sub-second inference (~400–700ms) with `qwen/qwen3.8-27b`, `groq/compound-mini`, and `openai/gpt-oss-20b`.
- **OpenRouter (Secondary)**: Free models fallback (`openrouter/free`, `google/gemma-4-31b-it:free`).
- **OmniRoute (Tertiary)**: Local daemon auto-combos (`auto/smart`, `auto/fast`, `auto/coding`, `auto/offline`).
- **Resilience**: 1.0s exponential backoff retry on HTTP 429 rate limits; bounded at max 6 HTTP attempts.

---

## 🧪 Testing

```bash
# Verify health
curl http://127.0.0.1:8001/health

# Test primary planning endpoint
curl -X POST http://127.0.0.1:8001/llm/plan \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "title": "Example Form",
    "elements": [{"tag": "input", "id": "name", "label": "Full Name", "value": "[PERSON_01]", "selector": "#name"}],
    "prompt": "Fill my name and submit",
    "history": []
  }'

# Test smart planning endpoint
curl -X POST http://127.0.0.1:8001/llm/plan-smart \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://example.com",
    "prompt": "Book ticket from Gorakhpur to Lucknow"
  }'
```
