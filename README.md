# RedactVision Agent

> **SIH 26171 — On-device Visual Perception for Light-weight Browser Agents**
> 
> **Team:** ByteForce  
> **Organization:** Indian Space Research Organisation (ISRO)  
> **Category:** Software

A privacy-preserving, on-device browser agent that detects, tokenizes, and redacts sensitive page content locally before sending sanitized context to a server-side LLM. The server reasons over anonymous semantic tokens (`[EMAIL_01]`, `[PERSON_01]`) and returns structured browser actions that are validated and executed locally — never exposing raw PII across the network boundary.

---

## Overview

RedactVision Agent solves the problem of cloud/browser automation leaking passwords, emails, names, financial data, and other PII when page context is transmitted to remote reasoning engines.

**Current implementation (what runs today):**

```
Browser Page
    ↓
Local DOM Extraction (content script)
    ↓
Local Privacy Firewall (detect + tokenize DOM text only)
    ↓
Sanitized DOM + safe visual metadata (tokens: [EMAIL_01], [PROFILE:email], etc.)
    ↓
Server LLM Reasoning (/llm/plan — FastAPI)
    ↓
Structured Action JSON (click / type / scroll / wait / navigate)
    ↓
Local Validation + Token Resolution (client only)
    ↓
Browser Execution
    ↓
Updated Page → Repeat
```

**Target architecture (Phase 12–13 — not yet wired):**

```
Browser Page
    ↓
┌─── Parallel Perception ─────────────────────────┐
│  DOM Extraction    Screenshot Capture            │
│  PrivacyFirewall  →  OCR (Tesseract.js)        │
│  (DOM text PII)      CV (Transformers.js)     │
│                        NER (Transformers.js)     │
│                        Evidence Fusion           │
└────────────────────────────────────────────────┘
    ↓
Sensitive Data Map (fused: type + bbox + confidence)
    ↓
┌─── Local Redaction ────────────────────────────┐
│  DOM: replace with [TYPE_01] tokens            │
│  Visual: blur/mask face/document/card regions  │
└────────────────────────────────────────────────┘
    ↓
Sanitized Context (DOM tokens + sanitized image)
    ↓
Server LLM Reasoning
    ...
```

**Primary privacy objective:** Sensitive information is detected and sanitized on the client's device before any relevant context crosses the network boundary.

---

## Problem Statement

Cloud-based browser agents need visual and structural page context to automate workflows. Sending raw screenshots, full DOM, or page text can expose:

- Passwords and credentials
- Email addresses and phone numbers
- Financial values and card numbers
- Names, government IDs, and personal messages
- API keys, tokens, and authentication secrets
- Faces and visual PII rendered in images or canvas

Standard DOM-based automation is insufficient because sensitive content can exist in:

- Dynamically generated UI
- Canvas or image-rendered text
- Screenshots and visual elements not reliably represented in the DOM
- Custom components with hidden semantics
- Content whose meaning requires visual perception (faces, documents, cards)

This project implements a layered local perception pipeline — **currently active:** DOM semantics + regex/heuristics + tokenization. **Modules exist but not wired:** screenshot capture, OCR (`ocr-engine.ts`), CV/vision (`cv-engine.ts`), NER (`ner-engine.ts`), evidence fusion (`perception-pipeline.ts`), and visual redaction (`visual-redaction-engine.ts`). These are planned for Phase 12–13 and are NOT yet integrated into the default agent loop. See "Current Perception Pipeline Status" below.

---

## Key Features

| Feature | Status | Notes |
|---|---|---|
| Chrome MV3 Extension | **Implemented** | Content script, service worker, popup, floating chat panel |
| Local DOM Perception | **Implemented** | `extractPageDOM()` extracts interactive/text elements locally |
| Sensitive-Data Detection (DOM + regex) | **Implemented** | Layer 1: DOM semantics; Layer 2: regex/heuristics (`pii-detector.ts`) |
| Semantic Tokenization | **Implemented** | `PrivacyFirewall` replaces raw values with `[TYPE_01]` tokens |
| Local Token Map | **Implemented** | Client-only; never sent to server; used only for local resolution |
| Sanitized Context Building | **Implemented** | Only tokenized DOM elements cross network |
| In-Page Chat Panel | **Implemented** | Floating launcher + draggable 380×580 card (`chat-ui.ts`) |
| Server-Side LLM Reasoning (`/llm/plan`) | **Implemented** | Multi-provider bounded fallback (Groq → OpenRouter → OmniRoute) |
| Structured Action Schema | **Implemented** | Click / type / scroll / select / wait / navigate / done |
| Local Action Validation | **Implemented** | Schema + target existence + visibility + confidence checks |
| Browser Action Execution | **Implemented** | Token resolution locally, then execution (`action-executor.ts`) |
| Multi-Iteration Feedback Loop | **Implemented** | Perceive → Plan → Validate → Execute → Observe → Repeat (max 8 iterations) |
| Local OCR Engine | **Wired with graceful fallback** | `AgentSession.runPrompt()` invokes `perception-pipeline.ts`; OCR depends on optional Tesseract.js availability |
| Local NER Engine | **Wired with graceful fallback** | Transformers.js local inference is attempted when available |
| Local CV Engine | **Wired with graceful fallback** | Vision detection is attempted locally; failures degrade to DOM-only sanitization |
| Visual Redaction / Screenshot Pipeline | **Partially active** | Background screenshot capture feeds local perception; planner payload receives safe visual metadata, not raw screenshots |
| Encrypted Local Profiles | **Implemented** | Profile values are encrypted with AES-GCM before `chrome.storage.local`; the non-extractable key is kept in IndexedDB |
| WebSocket Agent Messaging (`/ws/agent`) | **Implemented** | For agent session messaging; planning uses HTTP `/llm/plan` |

---

## ⚠️ Critical Implementation Gap — Visual Perception / Redaction (Phase 13)

**Current status:** The default agent loop attempts screenshot capture, OCR, local NER, CV vision detection, and evidence fusion before planning. These steps are local and may degrade if optional local packages/models are unavailable. Raw screenshots are not sent to the server.

**Remaining risk:** Sensitive data rendered only in images, canvas, or other visual regions is protected only when local capture/model components succeed for that page. When visual capture or local inference is unavailable, the chat timeline reports the degraded mode and the server still receives no raw screenshot.

**To close this gap (the exact workflow):**

```text
What to tell Claude / your teammate:
"Integrate the perception pipeline into content/content.ts before sending /llm/plan.
Steps: 1) Capture screenshot (perception/screenshot-capture.ts). 2) Run DOM + screenshot in parallel through perception-pipeline.ts (OCR + CV + NER). 3) Build SensitiveDataMap (perception/sensitive-data-map.ts). 4) Apply visual redaction (blur/mask regions via perception/visual-redaction-engine.ts). 5) Build sanitized context with sanitized DOM + sanitized image. 6) Only then send to /llm/plan. Do not claim visual redaction is done until step 4 runs in the default loop."
```

**Files involved:** `extension/src/agent/agent-session.ts`, `extension/src/perception/screenshot-capture.ts`, `extension/src/background/service-worker.ts`, and the perception engines under `extension/src/perception/`.

---

## Architecture

### Conceptual Flow

```text
┌─────────────────┐
│     Browser     │
│  (Active Tab)   │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Chrome Manifest V3 Extension       │
│  ├─ Content Script                  │
│  │   └─ DOM extraction              │
│  ├─ Privacy Firewall (local)       │
│  │   ├─ DOM semantics              │
│  │   ├─ Regex / heuristics         │
│  │   └─ Optional OCR / NER / CV     │
│  ├─ Semantic Tokenizer              │
│  │   └─ Local token map (client)   │
│  ├─ Sanitized Context Builder       │
│  └─ Floating Chat Panel             │
└────────┬────────────────────────────┘
         │  SANITIZED PAYLOAD (tokens only)
         ▼
┌─────────────────────────────────────┐
│  === NETWORK BOUNDARY ===            │
│  FastAPI Server (localhost:8001)   │
│  ├─ /llm/plan (POST)                │
│  ├─ /llm/health                     │
│  ├─ /ws/agent (WebSocket)           │
│  ├─ /privacy-status                 │
│  └─ /api/analyze                    │
└────────┬────────────────────────────┘
         │  STRUCTURED ACTION JSON
         ▼
┌─────────────────────────────────────┐
│  Server-Side LLM Reasoning          │
│  (Groq / OpenRouter / OmniRoute)     │
│  → PlanNextAction()                 │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Client Action Validator             │
│  ├─ Schema check                    │
│  ├─ Target existence / visibility   │
│  ├─ Confidence threshold            │
│  └─ Policy / risk check             │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────┐
│  Local Token Resolution (if needed)  │
│  ├─ Resolve [EMAIL_01] locally       │
│  └─ Execute in browser              │
└────────┬────────────────────────────┘
         │
         ▼
         NEW PAGE STATE
         │
         └────── Re-perceive → Re-sanitize → Re-reason → Repeat
```

### Component Responsibilities

| Layer | Runs Where | Responsibility |
|---|---|---|
| DOM Perception | Browser (extension content script) | Extract interactive/text elements (`extractPageDOM`) |
| Local Privacy Firewall | Browser | Detect PII, tokenize, maintain local token map (`PrivacyFirewall`) |
| Semantic Tokenization | Browser | Replace raw values with `[TYPE_01]` (`sanitizePage`) |
| Sanitized Context | Browser → Network | Only tokenized DOM + user prompt sends to server |
| Agent / LLM Reasoning | Server (`/llm/plan`) | Understand natural-language task, return structured action |
| Action Validation | Browser | Schema, target, visibility, confidence, policy (`validate`) |
| Browser Execution | Browser | Click / type / scroll / select / wait / navigate (`execute`) |
| Token Resolution | Browser (local only) | Resolve token references back to original values (`resolveToken`) |

### Critical Architectural Boundary

> **The server is the sole planner for natural-language tasks.** The client does not contain hardcoded prompt-to-action rules or keyword matching (the architecture explicitly rejects a local fallback-only planner; `llm-planner.ts` maps all backend choices to `"server"`). All task understanding belongs to the server-side LLM. The client's execution layer validates and performs only structured JSON returned by the server.

---

## End-to-End Data Flow

1. User opens a webpage (e.g., `http://localhost:8000/` — controlled test form)
2. Chrome extension initializes; content script loads (`document_idle`)
3. `extractPageDOM()` reads interactive/text elements locally
4. `PrivacyFirewall.sanitizePage()` detects sensitive values (name, email, phone, password) and replaces them with tokens (`[PERSON_01]`, `[EMAIL_01]`, `[PHONE_01]`, `[PASSWORD_01]`)
5. User opens the floating chat panel (launcher pill at bottom-right)
6. User enters a natural-language task (e.g., "Click submit")
7. `AgentSession.runPrompt()` builds sanitized context and sends `PlanRequest` to `http://127.0.0.1:8001/llm/plan` via `planViaServer()` (through background service worker to avoid CORS)
8. Server validates privacy contract (`validate_action_request` — rejects if token map or raw PII present)
9. `plan_with_llm()` calls multi-provider chain (Groq → OpenRouter → OmniRoute), bounded at 6 HTTP calls max
10. Server returns structured `PlanResponse` (e.g., `{"action":"click","target":"#submit-btn","confidence":0.97}`)
11. Client validates action (`executor.validate`) — checks allowed action type, target exists, visibility, confidence >= 0.5
12. For `type` actions with token value: `resolveToken()` restores original locally; never sent to server
13. `executor.execute()` performs browser action (click / type / scroll / select / wait)
14. Page state updates; `AgentSession` observes new DOM, re-runs privacy firewall, and loops (up to `maxIterations = 8`)
15. Completion detected either by planner's `done: true`, duplicate-action guard, or safety cap

---

## Privacy Model

### What stays local (never crosses network)

- Original sensitive values (`rahul@gmail.com`, `9876543210`, `MySecretPassword123`)
- The local token map (`Map<string, TokenRecord>` — `{token → originalValue}`)
- Raw screenshots containing PII — screenshots are processed locally; the server receives only sanitized DOM and safe visual-region metadata
- Any console/log output containing raw PII

### What crosses the network

- Sanitized page URL and title
- DOM elements with semantic tokens (e.g., `value: "[EMAIL_01]"`)
- User task prompt (after applying project privacy policy)
- Capture timestamp

### Server never receives

- `local_token_map`
- Original emails, phones, names, passwords
- Credit card numbers
- Any PII the client detected

### Client always validates

Every server-generated action passes local schema validation, target verification, and policy checks before browser execution. High-risk actions (payment, deletion, irreversible submissions) require explicit user confirmation.

---

## Project Structure

```text
RedactVision-Agent/
├── CLAUDE.md                 # Project rules + architecture instructions
├── README.md                 # This file
├── .env.example              # Environment template (keys never committed)
├── .env                      # Your local keys (ignored by git)
├── .gitignore
├── docs/
│   ├── ARCHITECTURE.md
│   ├── PROJECT_SPEC.md
│   ├── SECURITY_MODEL.md
│   ├── ROADMAP.md            # Phase milestones (0–19); current: 13–15 in progress
│   ├── SIH26171_ByteForce-v2(1).pdf
│   └── ...
├── extension/                # Chrome Manifest V3 extension
│   ├── manifest.json         # V3, permissions: activeTab, scripting, storage
│   ├── package.json          # esbuild, typescript build scripts
│   ├── tsconfig.json        # ES2022 / strict / noEmit
│   ├── src/
│   │   ├── content/content.ts        # Main content script + chat panel
│   │   ├── content/dom-extractor.ts  # DOM → structured elements
│   │   ├── privacy/
│   │   │   ├── privacy-firewall.ts  # Tokenization + local map
│   │   │   ├── pii-detector.ts      # Regex / heuristic detection
│   │   │   └── privacy-types.ts
│   │   ├── agent/
│   │   │   ├── agent-session.ts     # Multi-iteration loop
│   │   │   ├── state-machine.ts
│   │   │   └── action-planner.ts
│   │   ├── llm/
│   │   │   ├── lllm-planner.ts     # Server-LLM-only planner
│   │   │   ├── extension-bridge.ts # HTTP fetch to server
│   │   │   └── action-schema.ts    # LLM output schema
│   │   ├── executor/
│   │   │   ├── action-executor.ts  # Validate + execute
│   │   │   └── action-validator-executor.ts
│   │   ├── perception/             # OCR / NER / CV engines
│   │   ├── ui/chat-ui.ts           # Floating card builder
│   │   └── background/service-worker.ts
│   └── dist/                    # Built output (content, background, popup, ui)
├── server/                    # FastAPI backend
│   ├── pyproject.toml         # Python >=3.10, fastapi, uvicorn, pytest
│   ├── README.md              # Server quick start, endpoints, privacy contract
│   ├── tests/test_llm_planner.py
│   └── redactvision_server/
│       ├── main.py            # FastAPI app (8001), /llm/plan, /ws/agent
│       ├── llm.py             # Prompt + JSON parsing + schema validation
│       ├── planner_prompt.py  # SYSTEM_PROMPT + build_user_prompt()
│       ├── multi_provider_llm.py  # Bounded chain (Groq → OpenRouter → OmniRoute)
│       ├── providers.py        # Provider implementations + blacklist
│       ├── types.py            # Pydantic models (SanitizedEvent, etc.)
│       └── mock_agent.py      # Test-page rule planner (not production)
└── test-site/                 # Controlled local test page
    └── index.html             # Form with name, email, phone, password, country, message, submit, cancel
```

---

## Prerequisites

- **Operating System:** Linux / macOS / Windows (Linux tested)
- **Node.js:** Required for extension build (see `extension/package.json`)
- **npm:** For extension dependencies and build (`esbuild`, `typescript`)
- **Python >= 3.10:** Required for server (`pyproject.toml`)
- **Google Chrome / Chromium:** For extension loading and testing
- **Optional:** `omniroute` (local OpenAI-compatible router, port 20128) if you want the tertiary fallback without external keys
- **Optional GPU / WebGPU:** Not required for current prototype; vision pipeline degrades gracefully

Verify versions:

```bash
node --version   # should work (any recent)
npm --version
python3 --version  # >= 3.10
```

The project does not require a GPU for the current implemented phases. The on-device visual pipeline (`cv-engine.ts`, `ocr-engine.ts`) loads models on demand and falls back to empty results if memory/model loading fails.

---

## Installation

### 1. Clone

```bash
git clone <repository-url>
cd RedactVision-Agent
```

> If you don't have the repository URL, use your team's Git URL. The repository is maintained by ByteForce for SIH 26171.

### 2. Create Python virtual environment (optional but recommended)

```bash
python3 -m venv .venv
source .venv/bin/activate  # Linux/macOS; .venv\Scripts\activate on Windows
```

### 3. Install server dependencies

```bash
cd server
pip install -e ".[dev]"
```

> This installs `fastapi`, `uvicorn`, `python-dotenv`, `python-multipart`, `httpx`, plus dev extras (`pytest`, `pytest-asyncio`).

### 4. Install extension dependencies

```bash
cd extension
npm install
```

---

## Environment Configuration

Copy the template and add at least one LLM provider key.

```bash
cp .env.example .env
```

Edit `.env` (never commit it — it's in `.gitignore`):

```env
# Primary (fast, structured JSON output)
GROQ_API_KEY=your_groq_key_here
# Optional pin: GROQ_MODEL=groq/compound-mini

# Secondary (free models only; used when Groq fails)
OPENROUTER_API_KEY=your_openrouter_key_here
# Optional: OPENROUTER_FREE_MODELS=openrouter/free,google/gemma-4-31b-it:free

# Tertiary fallback (local CLI router; auth optional for localhost)
OMNIROUTE_URL=http://localhost:20128/v1/chat/completions
OMNIROUTE_MODEL=auto/best-reasoning
# OMNIROUTE_API_KEY=  # only needed if OMNIROUTE_URL is remote

# General settings
LLM_TIMEOUT_SECONDS=30
LLM_RETRIES_PER_PROVIDER=1
```

### Provider fallback order (bounded — no infinite retry)

1. **Groq** (`GROQ_API_KEY`) — primary; `groq/compound-mini` by default
2. **OpenRouter** (`OPENROUTER_API_KEY`) — secondary; free-only (`openrouter/free`)
3. **OmniRoute** (`OMNIROUTE_URL`) — tertiary; local `auto/best-reasoning`

Within a provider: 1 retry on retryable errors (rate limit, timeout, 5xx). Non-retryable errors (401, 404, 410) move to the next provider immediately. After all 3 providers fail, server returns **502** (`llm_unavailable`) — it never silently substitutes a hardcoded mock planner.

If no key is set for any provider: server returns **503** (`llm_not_configured`). The extension shows "Agent offline" clearly rather than inventing an action.

---

## Backend Setup

### Start server

```bash
cd server
start-server
# or directly:
python -m redactvision_server.main
# or with uvicorn explicitly:
uvicorn redactvision_server.main:app --reload --port 8001 --host 127.0.0.1
```

Expected startup output includes:
- `Loaded environment from .../RedactVision-Agent/.env`
- `Configured LLM providers: ...` (if keys set)
- `No LLM providers configured at startup.` (if no keys — expected until `.env` set)

### Verify backend is running

```bash
curl http://127.0.0.1:8001/
# → {"service":"RedactVision Agent Server","version":"0.1.0","status":"running","privacy":"token_map_never_received"}

curl http://127.0.0.1:8001/health
# → {"status":"healthy","timestamp":...,"connections":0}

curl http://127.0.0.1:8001/privacy-status
# → Full privacy contract (what server receives / never receives / returns)

curl http://127.0.0.1:8001/llm/health
# → Provider availability and model slugs
```

### LLM planning endpoint

```bash
curl -X POST http://127.0.0.1:8001/llm/plan \
  -H "Content-Type: application/json" \
  -d '{
    "url":"http://localhost:8000/",
    "title":"Test Form",
    "elements":[{"tag":"input","id":"email","value":"[EMAIL_01]","selector":"#email"}],
    "prompt":"Click submit",
    "timestamp":0
  }'
```

Response when configured:
```json
{"action":{"action":"click","target":"#submit-btn","confidence":0.97,"reasoning":"..."},"source":"server-llm","provider":"groq"}
```

Response when not configured (503):
```json
{"error":"llm_not_configured","message":"No LLM provider is configured...","code":"llm_not_configured"}
```

---

## Chrome Extension Setup

### Build

```bash
cd extension
npm run build
```

This runs `tsc --noEmit`, then `esbuild` bundles for:
- `content/content.ts` → `dist/content/content.js`
- `background/service-worker.ts` → `dist/background/service-worker.js`
- `popup/popup.ts` → `dist/popup/popup.js`
- Assets copied to `dist/popup/` and `dist/ui/`

### Load into Chrome

1. Open Chrome → navigate to `chrome://extensions/`
2. Enable **Developer mode** (toggle at top-right)
3. Click **Load unpacked**
4. Select the `extension/` directory (the folder containing `manifest.json` and `dist/`)
5. The extension should appear with:<br>
   - Name: **RedactVision Agent**<br>
   - Version: 0.2.0<br>
   - Permissions: `activeTab`, `scripting`, `storage`

### Verify extension

- Open any webpage; the red **RV** launcher pill should appear at bottom-right
- Clicking it opens the floating chat card (380×580, draggable, minimizable)
- The card shows status, redaction summary, and input field

### After code changes

```bash
npm run build
```
Then in Chrome (`chrome://extensions/`):
- Click **Reload** on the RedactVision Agent card, or
- Refresh the target page (content script reloads on `document_idle`)

---

## Extension Manifest (Manifest V3)

Key parts of `manifest.json`:

- `manifest_version`: 3
- `permissions`: `activeTab`, `scripting`, `storage`
- `host_permissions`: `http://localhost:*/*`, `http://127.0.0.1:*/*`, `https://huggingface.co/*`, `https://cdn-lfs.huggingface.co/*`
- `content_scripts`: runs at `document_idle` on `<all_urls>` — injects `dist/content/content.js`
- `background`: `service_worker` (ES module) at `dist/background/service-worker.js`
- `action`: popup at `dist/popup/popup.html`
- `web_accessible_resources`: `dist/ui/chat-ui.css`

The service worker routes all server-bound requests (`RV_PLAN_ACTION`, `RV_PING_SERVER`) so content scripts can reach `localhost:8001` without CORS errors (content scripts are origin-bound; the service worker runs in the extension origin with privileged network access).

---

## Test / Demo Page Setup

The repository includes a controlled test page with representative form elements.

```bash
cd test-site
python3 -m http.server 8000
```

Open `http://localhost:8000/` in Chrome.

The page contains:
- Form (`id="demo-form"`)
- Full Name input (`id="full-name"`, `autocomplete="name"`)
- Email input (`id="email"`, `value="rahul@gmail.com"` — sample PII)
- Phone input (`id="phone"`, `value="9876543210"`)
- Password input (`id="password"`, `value="MySecretPassword123"`, `type="password"`)
- Country select (`id="country"`)
- Message textarea (`id="message"`, contains `"Please contact Rahul about his account."`)
- Submit button (`id="submit-btn"`, text "Submit Form")
- Cancel button (`id="cancel-btn"`)
- Info box describing the test

This is the deterministic page for development and regression testing before testing on arbitrary websites.

---

## Running the Complete System

Open three terminals (or run in background):

### Terminal 1 — Test Page

```bash
cd test-site && python3 -m http.server 8000
```

### Terminal 2 — Server

```bash
cd server && source ../.venv/bin/activate  # if using venv
start-server
# Expected: uvicorn on 127.0.0.1:8001
```

### Browser — Load Extension

```bash
# 1. chrome://extensions/ → Load unpacked → select extension/
# 2. Open http://localhost:8000/
# 3. Click the red RV pill → open chat card
```

### First test

In the chat card:
- Type: `Click submit`
- Click Send
- Observe stages: Understanding task → Analyzing page → Privacy Firewall → Sanitized context ready → Agent reasoning → Action validated → Executing action → Completed
- The agent should click `#submit-btn`
- The page shows a green toast: "✓ Test form submitted"

---

## Using the Agent

### Start a task

1. Open the chat card (click RV pill)
2. Type a natural-language prompt:
   - `Click submit`
   - `Fill email with test@test.com`
   - `Select India`
   - `Type message`
3. Click **Send** (blue button)

### Read the privacy summary

The redaction card in the chat UI shows:
- Number of sensitive values detected locally
- Breakdown by type (`PERSON`, `EMAIL`, `PHONE`, `PASSWORD`, etc.)
- Confirmed: nothing raw was sent to the server

### Watch the pipeline

The timeline shows each phase:
- `Analyzing page` (DOM read)
- `Privacy Firewall` (tokenization)
- `Sanitized context ready` (elements prepared)
- `Agent reasoning` (server LLM call via `/llm/plan`)
- `Action validated` / `Executed` / `Observation`
- `Completed` or `Failed`

### Understand server state

The header pill shows the backend label (e.g., `Server` with provider name when configured, or `Server (offline)` if no LLM configured). This reflects whether the `/llm/plan` endpoint returned `source: "server-llm"` or `"none"`.

---

## How Redaction Works

When the content script loads (`document_idle`):

1. `PrivacyFirewall` is instantiated (`new PrivacyFirewall()`)
2. `sanitizePage(extractPageDOM())` scans every interactive/text element
3. `detectSensitiveData()` applies layered detection:
   - **Layer 1 (DOM semantics):** `input type="password"`, `autocomplete`, `name`, `id`, `placeholder`
   - **Layer 2 (Regex/heuristics):** Email (`\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b`), Phone (`(?:\+91[\s-]?)?[6-9]\d{9}`), Cards (`\d{13,19}`), Aadhaar (`\d{4}[\s-]?\d{4}[\s-]?\d{4}`), Password (context-dependent: `type === "password"` or context includes "password"/"passcode")
   - **Layer 3 (Context-dependent):** Person names (`^[A-Za-z]+(?:\s+[A-Za-z]+){0,3}$` in name fields; contextual patterns like "contact Rahul") — only on `text`/`value` sources to avoid false positives like "Enter your full name"
4. For each match, `getToken()` creates or reuses a deterministic token (`[EMAIL_01]`, `[PHONE_01]`, etc.) based on counter per type
5. The original value is stored in the local `tokenMap` (`Map<string, TokenRecord>`)
6. The sanitized text replaces the original value with the token
7. No raw value ever enters `sanitizedPageDOM`

When the server needs a token for a `type` action (e.g., type into email field):
- `ActionExecutor.executeType()` detects token format (`/^\[[A-Z_]+_\d+\]$/`)
- Calls `privacyFirewall.resolveToken(value)` to get original locally
- Types the original value into the browser
- Logs only `token [EMAIL_01]` or length (`7 chars`), never the raw value

---

## How Local Perception Works

**Current active path (runs from `AgentSession.runPrompt()`):**

```
extractPageDOM()
  → querySelectorAll(["input","textarea","select","button","a","img","form","[role]","[aria-label]"])
  → extractElement() per node (tag, id, classes, type, name, text, value, placeholder, ariaLabel, selector)
  → background screenshot capture when extension permissions allow it
  → perception-pipeline.ts attempts OCR + NER + CV locally
  → PrivacyFirewall.sanitizePage()  (Layer 1: DOM semantics; Layer 2: regex/heuristics)
  → sanitized DOM tokens + safe visual-region metadata
```

**Visual pipeline modules:**

- `ocr-engine.ts`: Tesseract.js for screenshot-based text extraction
- `ner-engine.ts`: Transformers.js for named entity recognition on text
- `cv-engine.ts`: Transformers.js vision pipeline for face / document / card detection (loads model on demand; graceful degradation)
- `screenshot-capture.ts`: Viewport capture for visual analysis through the background worker
- `perception-pipeline.ts`: Orchestrates DOM + OCR + NER + CV in parallel and fuses results into `SensitiveDataMap`
- `sensitive-data-map.ts`: Unified output schema (type, bbox, confidence, sources)
- `visual-redaction-engine.ts`: Blur / mask sensitive image regions

> Local OCR/CV/NER are optional runtime capabilities. If capture or model loading fails, the chat timeline reports the degraded scan and the planner still receives no raw screenshot.

---

## How Server AI Works

The server is the **sole planner** for natural-language tasks.

**Endpoint:** `POST /llm/plan`

**Request:** `PlanRequest` (sanitized DOM + prompt + optional history)

**Process:**
1. Validate privacy (`validate_action_request` — rejects if raw PII or token map present)
2. Build prompts (`planner_prompt.py` — `SYSTEM_PROMPT` instructs strict JSON-only output with schema; `build_user_prompt()` serializes sanitized DOM + user prompt)
3. Call `MultiProviderLLM.generate()` (bounded sequential chain)
4. Parse JSON (`_parse_json()` — strips markdown fences, finds first `{...}` block)
5. Validate shape (`validate_action_shape()` — checks `action`, `target`, `value`, `confidence` in `[0,1]`, `done`)
6. Return `PlanResponse`

**Provider chain (from `multi_provider_llm.py` / `providers.py`):**

| Order | Provider | Key Env | Default Model | Notes |
|---|---|---|---|---|
| 1 | Groq | `GROQ_API_KEY` | `groq/compound-mini` | Fast, structured JSON; 131k context verified |
| 2 | OpenRouter | `OPENROUTER_API_KEY` | `openrouter/free` | Free models only (user has no paid credits) |
| 3 | OmniRoute | `OMNIROUTE_URL` | `auto/best-reasoning` | Local CLI daemon (`http://localhost:20128`) |

**Bounded retry rules (deliberate design):**
- Per provider: retry once on retryable errors (408, 429, 500, 502, 503, 504)
- Non-retryable (400, 401, 403, 404, 410, 422) → move immediately
- No looping back to provider 1 after provider 3
- Max attempts: 3 providers × 2 calls = 6 HTTP calls
- On exhaustion: raises `RuntimeError`; server returns 502

The server does NOT invent actions when no LLM is configured — it returns 503 with a clear error message so the UI can show "Agent offline".

---

## Action Execution

When the client receives a `PlanResponse`:

1. **Schema validation** (`validate_action_shape`) — allowed actions, required fields, confidence in range
2. **Target verification** — `document.querySelector(action.target)` must exist
3. **Visibility / interactability** — element must be visible and interactable (implicit in `querySelector` + execution check)
4. **Policy / risk check** — high-risk actions may require confirmation (implemented in `action-validator-executor.ts`; configurable by policy)
5. **Token resolution** (for `type` with token value): `resolveToken()` locally
6. **Execution** (`execute`): `click()` / set `value` / `scrollBy()` / `select.value` / `setTimeout()`
7. **Result reporting** — `success`, `message`, `durationMs`; never logs raw sensitive values

Supported actions: `click`, `type`, `scroll`, `select`, `wait`, `navigate`, `done`.

---

## End-to-End Testing

### Smoke test (verified paths)

```bash
# 1. Start server (with at least one provider configured, or observe 503 behavior)
cd server && start-server

# 2. Load extension in Chrome
# 3. Open test page
python3 -m http.server 8000  # in test-site/
# Browse to http://localhost:8000/

# 4. Click RV pill → chat card
# 5. Type "Click submit" → Send
# 6. Observe: Analyzing → Privacy Firewall → Sanitized → Agent reasoning → Executed
```

### Privacy verification (manual)

In Chrome DevTools → **Network** tab:
- Filter `plan`
- Inspect the `POST /llm/plan` request body
- Confirm: `elements[].value` contains tokens (`[EMAIL_01]`), never `rahul@gmail.com`
- Confirm: no `token_map` field present
- Confirm: `prompt` contains task text (safe)

In server logs (`server/` terminal):
- Confirm server logs `Sanitized event from client` (no PII in log)
- Confirm `Privacy violation` only appears if you intentionally inject raw PII (test only)

### Server-only smoke test

```bash
cd server
python -m pytest tests/test_llm_planner.py -v
# Tests: parse JSON (clean/fenced/chatter), validation, prompt builder, mock planner
```

---

## Troubleshooting

### Backend won't start

- Check Python >= 3.10 (`python3 --version`)
- Check `.venv` activated (or install globally)
- Check dependencies installed (`pip install -e ".[dev]"`)
- Check `.env` exists (copy from `.env.example`)
- Check port 8001 not in use (`lsof -i :8001` or `ss -tlnp`)

### Server returns 503 (`llm_not_configured`)

- Set at least one of: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, or set `OMNIROUTE_URL` (local router runs without auth)
- Restart server (loads `.env` at startup)
- Verify with `curl http://127.0.0.1:8001/llm/health`

### Server returns 502 (`llm_unavailable`)

- All configured providers failed (check `.env` keys, network connectivity, provider status)
- Check server logs for retry attempts (bounded — max 6 attempts)
- If using Groq: verify key and model slug (`GROQ_MODEL` if pinned)
- If using OpenRouter: keys work only for free models with this setup
- If using OmniRoute: start local router (`omniroute`) or verify `OMNIROUTE_URL`

### Extension not appearing in Chrome

- Ensure **Developer mode** is enabled (`chrome://extensions/`)
- Select `extension/` directory (folder containing `manifest.json` and `dist/`), not `extension/dist/`
- Ensure `npm run build` completed (check `dist/content/content.js` exists)
- Reload extension card; refresh target page

### Extension changes not reflecting

- Rebuild: `npm run build`
- Reload extension (`chrome://extensions/` → Reload button)
- Refresh target page (content script injects at `document_idle`)
- Note: CSS is loaded at runtime from bundle (`chrome.runtime.getURL`); reload ensures new bundle

### Chat card not opening / launcher missing

- Ensure content script is loaded (`console.log("[RedactVision] Content script initialized")` in DevTools console)
- Check no JS errors blocking injection (CSS injection happens first; card renders after style load)
- If `file://` URL: inline CSS fallback activates (card should still render)

### API / connection errors

- Verify server running on `127.0.0.1:8001`
- Verify `.env` at project root (server looks up 2 levels from `main.py` → `../../.env`)
- Verify extension server URL in settings (default `http://127.0.0.1:8001`)
- Check CORS: server allows `http://localhost:*` and `chrome-extension://*`
- Check service worker handles `RV_PLAN_ACTION` (background message routing)

---

## Development Workflow

```bash
# 1. Start backend
cd server && start-server

# 2. Start test page
cd test-site && python3 -m http.server 8000

# 3. Build extension
cd extension && npm run build

# 4. Load / reload extension in Chrome
# 5. Open test page → click RV pill → test prompt
# 6. Make code change → rebuild → reload extension → refresh page → retest
```

### Lint / typecheck

```bash
# Extension
cd extension && npm run typecheck

# Server (Python — use flake8/pylint if configured; currently none required)
cd server && python -m py_compile redactvision_server/*.py
```

---

## Security & Privacy Notes

- **No secrets in repo:** `.env`, `.env.*`, `.venv/`, `node_modules/`, `extension/dist/` (build output) are in `.gitignore`; `.claude/` also ignored
- **No token maps committed:** The local token map is never written to persistent storage by design (only in-memory `Map`)
- **No raw PII in logs:** The extension logs token counts (`${summary.length}`) and sanitized status, never original values. The server logs event counts and action decisions, never original PII.
- **Sanitized boundary:** The `=== NETWORK BOUNDARY ===` concept from `CLAUDE.md` is enforced: anything after `sanitizePage()` is safe to transmit; anything before is client-only.
- **Untrusted server responses:** Every action is validated locally (`validate`) before execution. The server never executes browser code directly.
- **Extension permissions are minimal:** `activeTab`, `scripting`, `storage` only — no unnecessary `tabs`, `downloads`, `bookmarks`, `history`

---

## Performance Considerations

- **Event-driven perception:** Content script runs at `document_idle`; perception is triggered by user interaction (chat prompt), not constant polling
- **Lazy model loading:** Vision/OCR/NER models loaded on demand; graceful degradation if unavailable
- **Minimal payload:** `trimElements()` caps elements at 50, text at 80 chars, active tags only (`input`, `textarea`, `select`, `button`, `form`, `a`) — prevents Groq 413 errors
- **Bounded LLM calls:** Max 6 HTTP attempts per planning request (3 providers × 2 attempts); 30s timeout per call; 120s client timeout
- **No full-screen processing:** DOM-only extraction is fast; visual pipeline is optional
- **Targets from `CLAUDE.md`:** Engineering targets (`<50ms` capture, `<300ms` end-to-end, `>95%` recall) are hypotheses — measure before claiming

---

## Limitations

- **Visual redaction status:** The default loop now attempts local screenshot/OCR/NER/CV perception and sends safe visual-region metadata to the planner. Full image masking support exists in `visual-redaction-engine.ts`; the planner payload intentionally avoids raw screenshots.
- **VLM server reasoning (Phase 14)** uses the existing LLM planner (`/llm/plan`) via text-only API; true multi-modal image reasoning is not yet implemented
- **WebSocket agent messaging** (`/ws/agent`) exists but the primary planning flow uses HTTP (`/llm/plan`); full bidirectional agent session over WebSocket is not wired
- **Local vision model** loading depends on browser support (WebGPU / WASM / ONNX Runtime Web) and memory; graceful degradation is implemented but full performance not benchmarked
- **On-device model selection** (Transformers.js with `onnx-community/Qwen2.5-0.5B-Instruct`) is configured for privacy/perception assistance; server LLM remains the sole action planner
- **Security hardening (Phase 15)** — allowlists, prompt-injection defense, rate limiting — partially implemented via validation layer; full hardening is planned
- **Benchmarking (Phase 16)** — no benchmark results committed; targets from `CLAUDE.md` §16 remain unverified
- **Real-world websites:** The prototype is tested against the controlled test page (`test-site/index.html`). Arbitrary websites may have complex DOM structures requiring additional perception tuning

---

## Future Improvements (from ROADMAP.md phases 13–19)

- **Phase 13:** Visual redaction — blur/mask sensitive regions in screenshots
- **Phase 14:** VLM integration — multi-modal server reasoning with image context
- **Phase 15:** Security hardening — allowlists, prompt-injection defense, rate limiting
- **Phase 16:** Benchmarking — measure against SIH evaluation criteria
- **Phase 17:** End-to-end demo — deterministic presentation flow
- **Phase 18:** Demo / UI hardening — animations, processing indicators, privacy visualization
- **Phase 19:** Release documentation — reproducible repo, benchmarks, demo instructions

---

## Team Workflow & Status Summary (Read This First)

### What the team should know

This project is for **SIH 26171 — ByteForce**. The goal: a privacy-preserving browser agent that detects sensitive data locally, redacts it, sends only safe tokens to a server LLM (`/llm/plan`), and executes the returned structured actions.

### What is working today (implemented, runs in default flow)

- Chrome MV3 extension loads and injects content script (`document_idle`)
- `extractPageDOM()` reads interactive/text elements
- `PrivacyFirewall` detects DOM PII (Layer 1: DOM semantics + Layer 2: regex) and tokenizes (`[PERSON_01]`, `[EMAIL_01]`, etc.)
- `AgentSession.runPrompt()` attempts screenshot/OCR/NER/CV perception before each planner call and adds safe visual-region metadata
- Token map is local only (memory `Map`) — never in server payload
- Encrypted local profiles persist across reloads and expose only `[PROFILE:field]` capability tokens to the planner
- Floating chat card (`chat-ui.ts`) opens, sends prompts
- `AgentSession.runPrompt()` loops: perceive → sanitize → plan (`/llm/plan`) → validate → execute → observe (max 8 iterations)
- Server (`start-server`, port 8001) handles planning with bounded multi-provider fallback (Groq → OpenRouter → OmniRoute, max 6 HTTP attempts)
- Action validation + execution (`click`, `type`, `scroll`, `select`, `wait`, `navigate`, `done`) runs locally
- `test-site/index.html` (form with sample PII: `rahul@gmail.com`, `9876543210`, `MySecretPassword123`) works end-to-end
- All modules listed in `CLAUDE.md` exist and compile; basic privacy contract holds for detected DOM and visual metadata

### Remaining Gaps

Local OCR/CV/NER remain optional runtime capabilities. If model loading or tab
capture fails on a given machine/site, the agent reports the degraded scan and
continues with DOM sanitization. Full screenshot/image transfer to the server is
still intentionally disabled; only safe visual-region metadata is sent.

- `CLAUDE.md` — Project rules, privacy invariants, architecture, phase status
- `docs/ARCHITECTURE.md` — Detailed architecture documentation
- `docs/PROJECT_SPEC.md` — Engineering specification
- `docs/SECURITY_MODEL.md` — Threat model and defense strategies
- `docs/ROADMAP.md` — Phase milestones (0–19), current status, agent development rules
- `README.md` (server/) — Server quick start, endpoints, privacy contract
- `extension/package.json` / `tsconfig.json` — Build configuration
- `server/pyproject.toml` — Python dependencies and entry points
- `docs/Privacy-Preserving Agentic Browser Workflow (3)(1).png` — Proposed workflow visual
- `SIH26171_ByteForce-v2(1).pdf` — Original submission content

---

*Built for SIH 26171 by ByteForce. This is a working prototype — not a production guarantee. Verify behavior against source code and local tests before making performance or privacy claims.*
