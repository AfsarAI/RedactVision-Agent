# RedactVision Agent

> **SIH 26171 — On-device Visual Perception for Light-weight Browser Agents**  
> **Team:** ByteForce &nbsp;|&nbsp; **Organization:** Indian Space Research Organisation (ISRO) &nbsp;|&nbsp; **Category:** Software

An on-device, privacy-preserving autonomous browser automation agent. RedactVision locally perceives webpage content, extracts visual/DOM structures, and dynamically redacts sensitive personal data (PII) before transmitting anonymized semantic tokens (`[PERSON_01]`, `[EMAIL_01]`, `[PROFILE:pan_card]`) to server-side reasoning models. Actions are planned via structured JSON, returned across the network boundary, and executed locally in the browser using Chrome DevTools Protocol (CDP) and simulated human cursor interactions.

---

## 🌟 Key Capabilities at a Glance

```
┌───────────────────────────────────────────────────────────────────────────────┐
│                           REDACTVISION AGENT ENGINE                           │
├───────────────────────────────────────┬───────────────────────────────────────┤
│ 🛡️ On-Device Privacy Firewall         │ 🎯 Multimodal Visual Grounding        │
│ • Local DOM & semantic tokenization   │ • On-device OCR spatial text mapping  │
│ • Zero raw PII network transmission   │ • VLM fallback coordinate detection   │
│ • AES-GCM encrypted profile vault     │ • Sub-millisecond selector caching    │
├───────────────────────────────────────┼───────────────────────────────────────┤
│ 🖱️ Visual Cursor & CDP Execution      │ 🚀 Multi-Tier Reasoning & Planning    │
│ • Simulated visual cursor (requestAF) │ • OmniRouter Zero-Config Auto-Combos  │
│ • Real CDP mouse/keyboard dispatch    │ • Upfront "Think-Before-Acting" plans │
│ • React/Google Forms/Lexical bypass   │ • Bounded cascade (Groq → OpenRouter) │
├───────────────────────────────────────┼───────────────────────────────────────┤
│ 🔀 Fan-Out Subagent Orchestrator      │ 🔄 Diagnostic & Auto-Recovery Protocol│
│ • Autonomous multi-tab parallel tasks │ • Context invalidation self-healing   │
│ • Subagent tab lifecycle management   │ • State snapshot preservation         │
│ • Multi-site query synthesis          │ • Exponential backoff message retry   │
└───────────────────────────────────────┴───────────────────────────────────────┘
```

---

## 🏗️ Architecture & Logical Flow

```text
                            USER TASK PROMPT
                  (e.g., "Fill my application for SDE intern")
                                   │
                                   ▼
                      ACTIVE BROWSER VIEWPORT
                                   │
                                   ▼
          ┌─────────────────────────────────────────────────┐
          │         MANIFEST V3 CHROME EXTENSION            │
          │                                                 │
          │  1. DOM Extraction & Pruning (< 10ms)           │
          │  2. On-Device OCR Spatial Mapping               │
          │  3. Local Privacy Firewall                      │
          │     ├─ Layer 1: Semantic DOM & ARIA rules       │
          │     ├─ Layer 2: Regex & Pattern tokenization    │
          │     └─ Layer 3: Local NER / CV visual detection │
          │  4. Semantic Token Replacement                  │
          │     └─ Token Map remains in-memory only         │
          └────────────────────────┬────────────────────────┘
                                   │
                   SANITIZED PAYLOAD (TOKENS ONLY)
                    (e.g., [PERSON_01], [EMAIL_01])
                                   │
                       === NETWORK BOUNDARY ===
                                   │
                                   ▼
          ┌─────────────────────────────────────────────────┐
          │           FASTAPI REASONING GATEWAY             │
          │              (http://127.0.0.1:8001)            │
          │                                                 │
          │  1. Input Privacy Contract Verification         │
          │  2. Defense-in-Depth Auto-Sanitizer             │
          │  3. Think-Before-Acting Planner (/llm/plan)     │
          │     ├─ Primary: Groq / OmniRouter auto/smart    │
          │     ├─ Secondary: OpenRouter free router        │
          │     └─ Fast Step Validation (/llm/validate-step)│
          │  4. Structured Action JSON Emission             │
          └────────────────────────┬────────────────────────┘
                                   │
                     STRUCTURED JSON ACTION
            {"action": "type", "target": "#f1", "value": "[PROFILE:name]"}
                                   │
                       === NETWORK BOUNDARY ===
                                   │
                                   ▼
          ┌─────────────────────────────────────────────────┐
          │       LOCAL ACTION EXECUTOR & VALIDATOR         │
          │                                                 │
          │  1. Action Schema & Target Validation           │
          │  2. Local Token Resolution (WebCrypto Vault)    │
          │  3. Fast-Path Selector Cache Lookup             │
          │  4. Simulated Visual Cursor Movement            │
          │  5. Low-Level CDP Execution (chrome.debugger)   │
          │     ├─ Input field select all + erase           │
          │     ├─ Native prototype setter dispatch         │
          │     └─ Authentic mouse & keyboard events        │
          └────────────────────────┬────────────────────────┘
                                   │
                                   ▼
                         UPDATED WEBPAGE STATE
                                   │
                     Re-Perceive → Validate → Repeat
```

---

## 🔒 Non-Negotiable Privacy Invariants

1. **Zero Raw PII on the Network**: Raw personal identifiers (real emails, phone numbers, real names, passwords, Aadhaar, credit cards) never cross the network boundary.
2. **Client-Side Token Map**: The mapping (`[PERSON_01] -> Shrijal Gupta`) is strictly held in browser runtime memory and is never transmitted, logged, or serialized into server requests.
3. **Encrypted Identity Vault**: Stored user profiles are encrypted at rest using **256-bit AES-GCM**. The non-extractable cryptographic key is isolated in browser **IndexedDB** (`redactvision-private-vault`).
4. **Untrusted Server Output**: Every action returned by the reasoning server is validated locally against element existence, type safety, interactability, and risk policies before execution.
5. **No Secret Leakage in Logs**: Server logs, telemetry, and extension debug logs sanitize sensitive values and record only semantic metadata.

---

## 🛠️ Core Subsystems

### 1. Local Privacy Firewall (`extension/src/privacy/`)

- **Layer 1 (DOM Semantics)**: Inspects input types, `autocomplete`, `name`, `id`, ARIA attributes, and Google Forms question structures (`aria-labelledby`, container headings).
- **Layer 2 (Pattern Detection)**: High-precision regex engines for emails, international/Indian phone numbers, payment cards (Luhn-verified), Aadhaar, API keys, and credentials.
- **Layer 3 (Context-Aware Masking)**: Protects names and personal data in free-form chat prompts (`sanitizeFreeText`) before sending to the server.
- **Interactive De-Anonymization**: If an action requires an unsaved field, the agent pauses gracefully with an `AskUserInfo` prompt in the chat rather than failing.

### 2. Multimodal Visual Grounding & OCR (`extension/src/executor/visual-grounding.ts`)

- **Instant OCR Spatial Map (`scanViewportTextRegions`)**: Extracts pixel coordinates `(x, y, width, height)` for all visible text across the viewport with zero latency.
- **Coordinate-Based Targeting (`locateOCRSpatialCoordinates`)**: Identifies input fields positioned relative to question headers (e.g. Google Forms) and clicks coordinates directly.
- **VLM Screenshot Fallback (`/llm/visual-ground`)**: For custom canvases or opaque WebGL interfaces, captures a compressed viewport screenshot and queries multimodal vision models to retrieve normalized `[0–1000]` coordinates.

### 3. Visual Cursor & CDP Execution Engine (`extension/src/executor/visual-cursor.ts`)

- **Simulated Visual Cursor**: Injects a custom SVG pointer (`#rv-visual-cursor`) with smooth `requestAnimationFrame` ease-in-out gliding trajectories, click ripple animations, and floating action badges (`Typing...`, `Clicking...`).
- **Chrome DevTools Protocol (CDP)**: Connects via `chrome.debugger` to dispatch real, trusted OS-level events (`Input.dispatchMouseEvent`, `Input.dispatchKeyEvent`, `Input.insertText`) that bypass synthetic event barriers in React, Vue, Lexical, Slate, and ProseMirror (e.g. ChatGPT, Claude).
- **Field Clearing Protocol (`setAndReplaceInputValue`)**: Dispatches `Cmd+A` / `Ctrl+A` and `Backspace` before inserting text and invokes native prototype property setters to prevent string concatenation bugs.

### 4. Fan-Out Subagent Engine (`extension/src/agent/subagent-orchestrator.ts`)

- **Task Decomposition**: Identifies multi-site requests (e.g. _"Search for SDE roles across Google, Amazon, and Microsoft"_) and decomposes them into parallel subagent tasks.
- **Multi-Tab Lifecycle Management**: Spawns isolated worker tabs (`RV_OPEN_TAB`), dispatches prompt execution (`RV_RUN_SUBAGENT_TAB`), monitors live progress, and closes tabs upon completion.
- **Report Synthesis**: Aggregates structured outcomes from each subagent and presents a consolidated report in the main chat widget.

### 5. Diagnostic & Auto-Recovery Protocol (`extension/src/diagnostic/diagnostic-protocol.ts`)

- **Context Invalidation Diagnostics (`isExtensionContextValid`)**: Guards content script executions against extension reload drops (`Extension context invalidated`).
- **Safe Message Channel (`safeSendMessage`)**: Wraps inter-component messaging with exponential backoff retries and explicit `chrome.runtime.lastError` interception.
- **Network Response Guardrails (`safeAgentFetch`)**: Prevents `TypeError: Cannot read properties of undefined (reading 'ok')` and standardizes API error handling.
- **State Snapshot Preservation (`saveTaskSnapshot`)**: Persists active task state to `sessionStorage` before exceptions, offering a 1-click `"🔄 Refresh Tab"` recovery banner.

### 6. Multi-Tier LLM Gateway (`server/redactvision_server/`)

- **OmniRouter Integration**: Leverages OmniRouter's Zero-Config Auto-Combos (`auto/smart` for planning, `auto/fast` for step validation, `auto/coding` for DOM scripts, `auto/cheap` for background tasks).
- **Bounded Cascade**: Fast primary inference via Groq (`qwen3.8-27b`, `groq/compound-mini`, `gpt-oss-20b`) with seamless fallback to OpenRouter free models and local OmniRoute.
- **Rate Limit Resilience**: Automated 1.0s exponential backoff on HTTP 429 errors.

---

## 📂 Repository Structure

```text
RedactVision-Agent/
├── README.md                          # Main documentation & architecture guide
├── .env.example                       # Environment configuration template
├── .env                               # Local secrets (gitignored)
├── .gitignore
│
├── extension/                         # Chrome Manifest V3 Extension
│   ├── manifest.json                  # Manifest V3 (activeTab, tabs, scripting, storage, debugger)
│   ├── package.json                   # Build toolchain (TypeScript, esbuild)
│   ├── tsconfig.json
│   ├── src/
│   │   ├── content/
│   │   │   ├── content.ts             # Content script entrypoint & chat mounting
│   │   │   ├── dom-extractor.ts       # Structural DOM & ARIA label extractor
│   │   │   └── dom-pruner.ts          # DOM snapshot pruner (12KB payload cap)
│   │   ├── agent/
│   │   │   ├── agent-session.ts       # Core autonomous ORAE session loop
│   │   │   ├── subagent-orchestrator.ts # Multi-tab parallel subagent orchestrator
│   │   │   ├── subagent-types.ts      # Fan-out contracts and state models
│   │   │   └── state-machine.ts       # Agent lifecycle state machine
│   │   ├── executor/
│   │   │   ├── action-executor.ts     # Action validator & execution dispatcher
│   │   │   ├── visual-cursor.ts       # Simulated cursor, ripple & human typing
│   │   │   ├── visual-grounding.ts    # OCR spatial locator & VLM fallback
│   │   │   └── selector-cache.ts      # Fast-path selector cache
│   │   ├── diagnostic/
│   │   │   └── diagnostic-protocol.ts # Auto-recovery, message retry & state snapshots
│   │   ├── privacy/
│   │   │   ├── privacy-firewall.ts    # Local privacy firewall & token map
│   │   │   ├── pii-detector.ts        # Layer 1/2 regex & heuristic PII detection
│   │   │   ├── profile-store.ts       # AES-GCM encrypted on-device profile vault
│   │   │   └── prompt-extractor.ts    # Prompt PII extractor
│   │   ├── perception/
│   │   │   ├── perception-pipeline.ts # Multimodal evidence fusion
│   │   │   ├── ocr-engine.ts          # Local Tesseract.js OCR engine
│   │   │   ├── ner-engine.ts          # Local Transformers.js NER engine
│   │   │   └── cv-engine.ts           # Local Transformers.js CV vision engine
│   │   ├── storage/
│   │   │   └── optimized-memory.ts    # In-memory cached session storage
│   │   ├── llm/
│   │   │   ├── action-schema.ts       # Structured action JSON schema
│   │   │   ├── llm-planner.ts         # Server planning orchestrator
│   │   │   └── extension-bridge.ts    # Background message routing bridge
│   │   ├── ui/
│   │   │   ├── chat-ui.ts             # Floating in-page card UI
│   │   │   └── chat-ui.css            # Frosted glass styling
│   │   ├── popup/
│   │   │   ├── popup.ts               # Settings dashboard & profile manager
│   │   │   ├── popup.html
│   │   │   └── popup.css
│   │   └── background/
│   │       └── service-worker.ts      # Background service worker & CDP controller
│   └── dist/                          # Generated build output (gitignored)
│
├── server/                            # FastAPI Server & Reasoning Gateway
│   ├── pyproject.toml                 # Dependencies & CLI entrypoints
│   ├── README.md
│   └── redactvision_server/
│       ├── main.py                    # FastAPI app (port 8001), routes & lifecycle
│       ├── llm.py                     # Think-Before-Acting & validation engine
│       ├── planner_prompt.py          # Strict JSON system prompt & few-shot examples
│       ├── providers.py               # Groq, OpenRouter & OmniRoute adapters
│       ├── multi_provider_llm.py      # Bounded multi-provider fallback orchestrator
│       ├── mock_agent.py              # Server-side defense-in-depth PII validator
│       └── types.py                   # Pydantic schemas (PlanRequest, SmartPlan, etc.)
│
└── test-site/                         # Controlled Evaluation & Test Sandbox
    └── index.html                     # Dynamic form test sandbox
```

---

## ⚡ Quickstart Guide

### Prerequisites

- **Node.js**: v18+ and `npm`
- **Python**: v3.10+
- **Google Chrome**: Recent version

---

### Step 1: Configure Environment

Copy the environment template in the project root:

```bash
cp .env.example .env
```

Edit `.env` with your preferred API keys:

```env
# Primary (Fast inference)
GROQ_API_KEY=your_groq_api_key_here
GROQ_MODEL=qwen/qwen3.8-27b

# Secondary (Free models fallback)
OPENROUTER_API_KEY=your_openrouter_api_key_here

# Tertiary (Local/Remote OmniRoute Router)
OMNIROUTE_URL=http://localhost:20128/v1/chat/completions
OMNIROUTE_MODEL=auto/smart

# General configuration
LLM_TIMEOUT_SECONDS=30
LLM_RETRIES_PER_PROVIDER=1
```

---

### Step 2: Start the Reasoning Backend

```bash
cd server
python3 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"

# Start server on http://127.0.0.1:8001
start-server
```

Verify backend health:

```bash
curl http://127.0.0.1:8001/health
# Response: {"status": "healthy", "timestamp": ..., "connections": 0}
```

---

### Step 3: Build & Load the Chrome Extension

```bash
cd extension
npm install
npm run build
```

1. Open Chrome and navigate to `chrome://extensions/`.
2. Toggle **Developer mode** (top right).
3. Click **Load unpacked** and select the `extension/` directory.
4. Pin the **RedactVision Agent** extension icon.

---

### Step 4: Run the Local Test Sandbox

```bash
cd test-site
python3 -m http.server 8000
```

1. Open `http://localhost:8000/` in Chrome.
2. Click the red **RV launcher pill** at the bottom-right corner.
3. Try sample commands:
   - `"Fill my form with my details"`
   - `"Fill name as Shrijal and submit"`
   - `"Select country India"`

---

## 📡 API Contract Reference

### 1. `POST /llm/plan` (Primary Action Planning)

Generates the next single browser action based on sanitized DOM context.

**Request (`PlanRequest`):**

```json
{
  "url": "https://example.com/apply",
  "title": "Application Form",
  "elements": [
    {
      "tag": "input",
      "id": "f1",
      "name": "fullName",
      "type": "text",
      "label": "Full Name",
      "value": "[PERSON_01]",
      "selector": "#f1"
    }
  ],
  "prompt": "Fill my form and submit",
  "history": []
}
```

**Response (`PlanResponse`):**

```json
{
  "action": {
    "action": "type",
    "target": "#f1",
    "value": "[PROFILE:name]",
    "confidence": 0.98,
    "reasoning": "Type user's saved name into the Full Name field.",
    "done": false
  },
  "source": "server-llm",
  "provider": "groq"
}
```

---

### 2. `POST /llm/plan-smart` (Think-Before-Acting Planner)

Generates a structured sequential plan with validation criteria using `auto/smart`.

**Response (`SmartPlanResponse`):**

```json
{
  "taskSummary": "Book a ticket from Gorakhpur to Lucknow on IRCTC",
  "steps": [
    {
      "stepId": 1,
      "actionType": "TYPE",
      "targetSelector": "#origin",
      "valueToInput": "Gorakhpur",
      "instructionsForSelf": "Type Gorakhpur into the origin station input.",
      "validationCheck": "Origin field contains 'Gorakhpur'."
    },
    {
      "stepId": 2,
      "actionType": "TYPE",
      "targetSelector": "#dest",
      "valueToInput": "Lucknow",
      "instructionsForSelf": "Type Lucknow into the destination input.",
      "validationCheck": "Destination field contains 'Lucknow'."
    },
    {
      "stepId": 3,
      "actionType": "CLICK",
      "targetSelector": "#search",
      "valueToInput": null,
      "instructionsForSelf": "Click search button.",
      "validationCheck": "Train list results page loaded."
    }
  ],
  "provider": "omniroute",
  "model": "auto/smart"
}
```

---

### 3. `POST /llm/validate-step` (Fast DOM State Validation)

Evaluates DOM state changes with sub-second latency using `auto/fast`.

**Request (`StepValidationRequest`):**

```json
{
  "step_instructions": "Origin field should contain 'Gorakhpur'",
  "current_dom": {
    "elements": [{ "tag": "input", "id": "origin", "value": "Gorakhpur" }]
  }
}
```

**Response (`StepValidationResponse`):**

```json
{
  "success": true,
  "reason": "Input element with id 'origin' matches expected value 'Gorakhpur'.",
  "confidence": 0.99
}
```

---

### 4. `POST /llm/visual-ground` (VLM Multimodal Grounding)

Resolves spatial coordinates from screenshot images when DOM selectors fail.

**Response (`VisualGroundResponse`):**

```json
{
  "found": true,
  "point": [450, 720],
  "box_2d": [700, 400, 740, 500],
  "description": "Submit button located in bottom action bar"
}
```

---

## 📋 Evaluation Criteria Alignment (SIH 26171)

| Evaluation Metric                               | Weight  | RedactVision Implementation                                                                 |
| :---------------------------------------------- | :-----: | :------------------------------------------------------------------------------------------ |
| **Visual-Context Accuracy**                     | **25%** | On-device OCR spatial mapping + CDP coordinate clicking + VLM multimodal fallback           |
| **Sensitive Data Detection Precision & Recall** | **20%** | Layered DOM semantics + standalone pattern detection + context-aware name/credential guards |
| **Redaction Precision**                         | **20%** | Deterministic semantic tokenization (`[PERSON_01]`, `[EMAIL_01]`) + local AES-GCM vault     |
| **Client Resource Utilization**                 | **20%** | Fast-path DOM pruning (< 15ms), debounced observers, in-memory caching, and selector cache  |
| **End-to-End Latency**                          | **15%** | Sub-second server inference (~400–700ms), 0ms blocking perception barriers                  |

---

## 👥 Team ByteForce

- **Lead & Development:** Team ByteForce
- **Problem Statement:** SIH26171 — On-device Visual Perception for Light-weight Browser Agents
- **Organization:** Indian Space Research Organisation (ISRO)
- **License:** MIT
