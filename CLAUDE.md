# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

---

## Development Commands

### Extension (Chrome MV3)

```bash
cd extension
npm install              # esbuild, typescript, @types/chrome
npm run build            # typecheck + bundle content/background/popup → dist/
npm run typecheck        # tsc --noEmit (fast, no emit)
```

Build outputs to `extension/dist/` (content/content.js, background/service-worker.js, popup/popup.js, ui/chat-ui.css). Load unpacked in Chrome (`chrome://extensions`) from `extension/`.

#### Source of truth vs. build output — DO NOT hand-edit `dist/`

- **`extension/src/`** is the **source of truth** and is tracked by git.
- **`extension/dist/`** is **build output** and is **gitignored** (`.gitignore` → `extension/dist/`). It is **never committed / pushed to GitHub**.
- `npm run build` regenerates `dist/` entirely from `src/` (typecheck → esbuild → `copy:assets` copies `src/ui/chat-ui.css` → `dist/ui/` and `dist/popup/`).

**Rules (MANDATORY):**
1. Always edit **`src/`** files (TS, CSS, HTML), never `dist/` directly. Any hand-edit to `dist/` is wiped on the next build and is invisible to teammates.
2. After changing any `src/` file, run `cd extension && npm run build` so the change lands in `dist/` and the running extension actually picks it up.
3. Because `dist/` is gitignored, a teammate who clones the repo **must run `npm install && npm run build`** locally to get a working `dist/` before loading the extension.
4. Verify you are editing tracked source with `git ls-files extension/` — a path that isn't listed is generated output, not source.

### Server (FastAPI + multi-provider LLM)

```bash
cd server
pip install -e ".[dev]"   # runtime + pytest/httpx

start-server              # uvicorn 127.0.0.1:8001 with reload (pyproject.toml script)
# or: python -m redactvision_server.main

python -m pytest tests/ -v             # full suite
python tests/test_llm_planner.py      # single file (standalone script, no pytest needed)
```

### Combined run (test site + server + extension)

```bash
# Terminal 1 — controlled test page
cd test-site && python3 -m http.server 8000

# Terminal 2 — server LLM planner
cd server && start-server

# Terminal 3 — optional local router (OmniRoute)
# npm i -g omniroute && omniroute   # http://localhost:20128

# Chrome → load unpacked extension → http://localhost:8000/ → click RV pill
```

### LLM provider setup (bounded chain, no infinite retry)

Priority: **Groq** → **OpenRouter** (free-only) → **OmniRoute** (localhost:20128, default). Keys in `.env` (copy `.env.example`); never commit `.env`. `.env` is loaded automatically by `main.py` (looked up from project root). The extension never holds server API keys.

---

## Architecture Overview

### Extension source tree (key files, not exhaustive)

```
extension/src/
  content/content.ts          — content script: in-page chat panel + launcher pill
  content/dom-extractor.ts   — DOM → structured elements (local only)
  privacy/
    privacy-firewall.ts       — detects + tokenizes PII; owns local token map
    pii-detector.ts          — Layer 1 DOM rules → Layer 2 regex/heuristics
  agent/
    agent-session.ts          — multi-iteration loop (perceive → plan → validate → exec)
    llm/llm-planner.ts       — server-LLM-only planner; no client fallback rules
  executor/
    action-executor.ts        — validate + execute click/type/scroll/select/wait
  perception/                 # OCR / NER / CV engines + screenshot capture
    screenshot-capture.ts    — viewport screenshot capture
    ocr-engine.ts            — Tesseract.js local OCR (wired with graceful fallback)
    ner-engine.ts            — Transformers.js NER (wired with graceful fallback)
    cv-engine.ts             — Transformers.js vision (face/doc/card detection, graceful degradation)
    perception-pipeline.ts   — Fusion orchestrator (DOM + OCR + NER + CV in parallel)
    sensitive-data-map.ts    — Unified SensitiveDataMap schema populated locally
  ui/chat-ui.ts              — floating 380×580 card; styles from extension bundle
  background/service-worker.ts
```

### Current perception pipeline status

The default chat agent flow runs:
```
extractPageDOM()
  + background visible-tab capture when available
  + perception-pipeline.ts (OCR / NER / CV with graceful fallback)
  → PrivacyFirewall.sanitizePage()
  → sanitized DOM + safe visual-region metadata
  → send to server
```

| Module | File | Status | Notes |
|---|---|---|---|
| Screenshot capture | `perception/screenshot-capture.ts` | Wired | Routed through background `chrome.tabs.captureVisibleTab` |
| OCR | `perception/ocr-engine.ts` | Wired/optional | Tesseract.js; degrades if unavailable |
| NER | `perception/ner-engine.ts` | Wired/optional | Transformers.js; degrades if unavailable |
| CV / Vision | `perception/cv-engine.ts` | Wired/optional | Face/doc/card detection with graceful degradation |
| Evidence fusion | `perception/perception-pipeline.ts` | Active | Combines DOM + OCR + NER + CV |
| Sensitive data map | `perception/sensitive-data-map.ts` | Active locally | Fusion output format |
| Visual redaction | `privacy/visual-redaction-engine.ts` | Available | Blur/mask sensitive image regions; planner payload currently sends safe metadata |

**Remaining limitation:** OCR/CV/NER depend on optional local packages/models and browser screenshot permissions. If they fail, the agent reports degraded visual scanning and continues with DOM sanitization. The server still never receives raw screenshots.

### Privacy token flow

`extractPageDOM()` → optional local visual perception → `PrivacyFirewall.sanitizePage()` replaces sensitive values in DOM text with semantic tokens (`[PERSON_01]`, `[EMAIL_01]`, etc.). Encrypted local profile values are exposed to the planner only as capability tokens such as `[PROFILE:name]`, `[PROFILE:email]`, or `[PROFILE:pan_card]`. The server never receives profile values, token maps, or raw screenshots.

When server returns a `type` action needing a token: `ActionExecutor` resolves page tokens or `[PROFILE:field]` tokens locally, asks the user when missing/ambiguous, then types the original value locally.

### Server source tree

```
server/redactvision_server/
  main.py              — FastAPI app; /llm/plan, /ws/agent, /health, /privacy-status
  llm.py               — JSON parser + action-shape validation + prompt assembly
  planner_prompt.py    — SYSTEM_PROMPT + build_user_prompt()
  multi_provider_llm.py — Sequential chain (Groq → OpenRouter → OmniRoute)
  providers.py         — Provider interface + implementations (blacklist model on 404/410)
  types.py             — SanitizedEvent, PlanRequest, PlanResponse, ServerAction
  mock_agent.py        — rule-based planner for test page only (not used in prod)
```

### Server LLM call path

`POST /llm/plan` receives `PlanRequest` → `validate_action_request()` (privacy re-check) → `plan_with_llm()` → `MultiProviderLLM.generate()` tries providers in order with at most 1 retry per provider (max 6 HTTP calls total, bounded by design). On all-providers-exhausted raises `RuntimeError`; server returns 502 with `llm_unavailable`. When no provider key is set returns **503 `llm_not_configured`** — never invents a hardcoded action silently.

### In-page chat panel

Content script injects a fixed launcher pill (bottom-right). Click opens a floating card (`buildChatUI()`) rendered directly into page DOM (not iframe). Draggable/minimizable/closeable; drag offset persisted per-hostname via `chrome.storage.local`. Owns an `AgentSession` that survives across prompts. Communicates with server via `planViaServer()` (HTTP POST to `/llm/plan`); WebSocket `/ws/agent` is for agent session messaging. CSS loaded from extension bundle at runtime (`chrome.runtime.getURL`); inline fallback for `file://`.

### Action contract

Server produces strict JSON (validated against `extension/src/llm/action-schema.ts`): `{action, target, value?, confidence, reasoning?, done?}`. Client validates schema, target existence, visibility/interactability, confidence threshold, domain/policy, risk level. High-risk actions (payment, deletion, external send) require explicit user confirmation per local policy.

---

# RedactVision Agent — Claude Code Project Instructions

## 1. Project Identity

- Team: **ByteForce**
- Product/project: **RedactVision Agent**
- SIH Problem Statement: **SIH26171 — On-device Visual Perception for Light-weight Browser Agents**
- Organization: **Indian Space Research Organisation (ISRO)**
- Category: Software
- Intended repo structure:
  - `SIH-26-ByteForce/`
    - `RedactVision-Agent/`
- The product name is **RedactVision Agent**. Older research material may call the concept **PrivaSight**; treat that as a historical/research alias, not the current product name.

## 2. Source-of-Truth Hierarchy

Use these sources in this order:

1. **Current source code + tests** — what is actually implemented.
2. **This `CLAUDE.md`** — non-negotiable project rules and current architecture invariants.
3. `docs/PROJECT_SPEC.md` if/when created — detailed engineering specification.
4. `docs/ARCHITECTURE.md` and `docs/API_CONTRACT.md` if/when created.
5. The supplied SIH PPT, research/context files, and workflow image in `docs/` — design/research background.

Research documents contain proposals and sometimes unverified claims. **Do not turn a proposed feature, benchmark target, model choice, latency number, or privacy claim into a fact unless the code/tests/benchmarks actually establish it.**

## 3. Core Problem

Cloud/browser agents need visual and structural page context to automate workflows, but sending raw screenshots or DOM content can expose passwords, PII, financial information, faces, private messages, credentials, tokens, and other sensitive data.

SIH requires a browser-side privacy-preserving vision agent that can:
- perceive the page locally;
- dynamically detect sensitive content;
- sanitize/redact it before network transmission;
- send only anonymized/sanitized context to server-side reasoning;
- receive actionable commands;
- validate and execute those commands locally.

The system must balance:
- visual-context accuracy — 25%;
- sensitive/PII detection precision and recall — 20%;
- redaction precision — 20%;
- client-side resource utilization — 20%;
- end-to-end latency — 15%.

## 4. Non-Negotiable Privacy Invariants

These rules must never be violated:

1. **Raw sensitive data must not cross the network boundary.**
2. The **local token map is client-only**. Never send it to the server.
3. Never send raw passwords, emails, phone numbers, names, financial values, faces, API keys, authentication tokens, or other detected sensitive values to the reasoning server.
4. Never log raw PII or secrets to the console, server logs, telemetry, analytics, or persistent storage.
5. Sanitization must happen **before** any network request containing page context.
6. Server responses are untrusted. Every server-generated action must pass local validation/policy checks before execution.
7. High-risk actions must require explicit user confirmation according to the local policy.
8. Never commit secrets, API keys, credentials, `.env` files, token maps, or generated sensitive test data.

If a proposed implementation conflicts with these invariants, reject the implementation rather than weakening the invariant.

## 5. Target Architecture

Logical flow:

```text
USER
  ↓
ACTIVE BROWSER TAB
  ↓
MANIFEST V3 EXTENSION
  ├─ Content Script
  │    └─ DOM / page-state extraction
  ├─ Local Privacy Firewall
  │    ├─ DOM/attribute detection
  │    ├─ regex/heuristic detection
  │    ├─ optional local NER/OCR
  │    └─ optional local vision detection
  ├─ Semantic Tokenizer / Redaction Engine
  │    └─ local token map
  ├─ Sanitized Context Builder
  ↓
=== NETWORK BOUNDARY ===
  ↓
FASTAPI SERVER / SECURE GATEWAY
  ↓
SERVER-SIDE VLM/LLM
  ↓
STRUCTURED JSON ACTION
  ↓
=== NETWORK BOUNDARY ===
  ↓
LOCAL ACTION VALIDATOR / POLICY ENGINE
  ↓
LOCAL TOKEN RESOLUTION (if required)
  ↓
BROWSER ACTION EXECUTOR
  ├─ click
  ├─ type
  ├─ scroll
  ├─ navigate
  └─ wait
  ↓
NEW PAGE STATE
  ↓
RE-PERCEIVE → RE-SANITIZE → REASON → VALIDATE → EXECUTE
```

The supplied workflow image in `docs/` illustrates the same trusted-zone/network-boundary concept: input capture → privacy firewall → semantic token replacement → secure server VLM → local validation/de-tokenization → browser execution.

## 6. Trusted-Zone Boundary

Everything before the network boundary is trusted client-side processing.

The server may receive:
- sanitized DOM structure;
- non-sensitive element metadata;
- semantic placeholders;
- sanitized/redacted visual context;
- bounding boxes/coordinates that are safe to disclose;
- user task text only after applying the project's privacy policy.

The server must **not** receive:
- the local token map;
- original sensitive values;
- raw screenshots containing detectable PII;
- raw password values;
- credentials or authentication secrets.

The token map is used only after a validated action returns to the client.

## 7. Current Implementation Status

The project is being built incrementally. The currently verified prototype includes the local test page and local DOM/privacy pipeline.

Observed working behavior:
- content script loads on the local test page;
- DOM elements are extracted;
- sensitive values are detected locally;
- values are replaced with semantic tokens;
- a local token map is generated;
- sanitized DOM is logged;
- the token map remains local.

Example verified tokenization:
- person/name → `[PERSON_01]`
- email → `[EMAIL_01]`
- phone → `[PHONE_01]`
- password → `[PASSWORD_01]`

Do not assume that WebGPU vision inference, OCR, server VLM reasoning, WebSocket action execution, or the full end-to-end loop is already implemented unless the repository confirms it.

## 8. Local Test Page

The current controlled test page is served at:

```text
http://localhost:8000/
```

It contains representative DOM elements including:
- form;
- full-name input;
- email input;
- phone input;
- password input;
- country select;
- message textarea;
- submit button;
- cancel button.

Use this page for deterministic development and regression testing before moving to arbitrary websites.

## 9. Privacy Detection Strategy

Use a layered approach. Prefer the cheapest/highest-confidence signal first:

### Layer 1 — DOM semantics
Inspect:
- input type;
- `name`;
- `id`;
- `placeholder`;
- `aria-label`;
- autocomplete;
- labels;
- relevant data attributes.

Password inputs and explicit sensitive field semantics should be deterministic/high-confidence.

### Layer 2 — Regex/heuristics
Detect patterns such as:
- email;
- phone;
- credit-card-like values;
- government-ID-like patterns where explicitly supported;
- API-key/token-like patterns where safely detectable.

### Layer 3 — Local NLP/NER
Use only if justified by the current implementation and performance budget. It should remain local.

### Layer 4 — Local visual/OCR detection
Use for sensitive information that is not represented reliably in the DOM, such as:
- faces;
- sensitive text rendered into images/canvas;
- documents/cards;
- other visual PII.

Do not add a heavy model merely because the research documents mention it. First establish that it is necessary and compatible with the browser/runtime.

## 10. Semantic Tokenization

Semantic placeholders should preserve enough meaning for server reasoning while removing the original value.

Examples:

```text
Rahul
→ [PERSON_01]

rahul@gmail.com
→ [EMAIL_01]

9876543210
→ [PHONE_01]

MySecretPassword123
→ [PASSWORD_01]
```

Important:
- token identifiers should be deterministic enough for the current task/round-trip;
- the original value belongs only in the local token map;
- the server should reason using token semantics, not the original value;
- do not expose the token map in debugging output sent to the server.

## 11. Redaction Policy

Use the least-destructive technique that still protects the sensitive value:

- text/DOM PII → semantic token replacement where useful;
- passwords/credentials → strong masking and no value transmission;
- faces → local blur/mask or another irreversible visual redaction;
- cards/documents → selective bounding-box redaction;
- high-risk content → stronger redaction/removal.

Preserve layout, element role, approximate geometry, and non-sensitive context where possible.

Never claim that a redaction is irreversible or perfectly private without testing it.

## 12. Context and Grounding

Preferred target grounding is:

1. stable internal element identifier / selector when available;
2. semantic element metadata;
3. accessibility information when available;
4. spatial coordinates as a fallback.

Do not rely on coordinates alone for important actions.

A sanitized payload should contain enough information for the server to reason about:
- page state;
- visible controls;
- labels;
- element roles;
- safe text;
- element geometry;
- available actions.

## 13. Server Action Contract

The server should return machine-readable structured actions, not free-form instructions.

Canonical conceptual shape:

```json
{
  "action": "click",
  "target": {
    "id": "submit-btn",
    "type": "button"
  },
  "confidence": 0.97
}
```

Supported action categories may include:

```text
click
type
scroll
navigate
wait
```

Before execution, the client must validate:
- schema;
- allowed action type;
- target existence;
- target visibility/interactability where applicable;
- confidence threshold;
- domain/policy restrictions;
- risk level;
- user confirmation requirement.

Never execute arbitrary JavaScript returned by the server.

## 14. Sensitive `type` Actions

A server must not invent or request raw secrets.

If an action needs a locally stored/tokenized value, use a safe token/reference mechanism and resolve it **only on the client after validation**.

Example concept:

```text
server action:
type [EMAIL_01] into email field

client:
validate action
→ resolve [EMAIL_01] locally
→ type original value locally
```

For passwords, credentials, payment information, or other high-risk secrets, default to stricter policy and user confirmation rather than autonomous typing.

## 15. Security Requirements

Treat webpage content as untrusted input.

Protect against:
- indirect prompt injection;
- hidden instructions in page content;
- malicious DOM;
- fake/spoofed controls;
- clickjacking-like UI deception;
- incorrect model actions;
- server compromise;
- data exfiltration;
- over-broad extension permissions.

The server's reasoning output is also untrusted.

Use:
- local allowlists/policy;
- action schema validation;
- target verification;
- visibility/interactability checks;
- risk classification;
- user confirmation for high-risk actions;
- minimal extension permissions;
- local action audit logs that do not contain sensitive values.

## 16. Performance Strategy

SIH cares strongly about client resources and latency.

Prefer:
- event-driven perception;
- MutationObserver/page-change triggers;
- ROI processing;
- lazy model loading;
- model reuse/caching;
- lightweight/quantized models where needed;
- WebGPU when actually available and beneficial;
- WASM fallback where required;
- minimal payloads;
- no unnecessary full-screen processing.

The research documents contain target numbers such as `<50ms`, `<100ms`, `<300ms`, `<150MB`, and `>95% recall`. Treat these as **engineering targets/hypotheses, not achieved results** until measured.

Instrument the pipeline so the final benchmark can separate:
- capture;
- DOM extraction;
- PII detection;
- local inference;
- redaction;
- payload serialization;
- network;
- server inference;
- action validation;
- browser execution.

## 17. Browser/Extension Architecture

Primary prototype target: **Chrome Manifest V3 + TypeScript**.

Expected responsibilities:

### Content Script
- read page DOM;
- collect safe element metadata;
- perform/coordinate local sanitization as appropriate;
- execute validated browser actions.

### Background Service Worker
- message routing;
- extension state;
- server communication where appropriate;
- lifecycle/event coordination.

### Offscreen/worker execution
Use when needed for expensive local inference or APIs unavailable/restricted in the service-worker context.

### Popup/UI
- agent enable/disable;
- privacy status;
- action confirmation;
- sensitivity/policy controls;
- safe local diagnostics.

Do not add React or another UI framework unless it provides clear value.

## 18. Technology Direction

Research/PPT materials currently propose combinations of:
- TypeScript;
- Manifest V3;
- Web APIs;
- WebGPU;
- WebAssembly/WASM SIMD;
- ONNX Runtime Web;
- Transformers.js;
- lightweight CV/OCR models;
- FastAPI;
- WebSockets;
- Qwen2.5-VL;
- vLLM;
- optional Supabase/Chrome `storage.local`;
- Docker/cloud GPU deployment.

These are **candidate technologies**, not mandatory implementation requirements.

Choose a technology only when:
1. it solves a demonstrated requirement;
2. it works in the target browser/runtime;
3. its resource cost is acceptable;
4. it does not weaken the privacy boundary;
5. it can be tested and demonstrated within the SIH scope.

## 19. Development Method

Work phase-by-phase. Do not build the entire system in one uncontrolled change.

For every phase:

1. inspect the existing implementation;
2. identify the minimum files that must change;
3. implement only that phase;
4. run relevant tests/typechecks/build;
5. inspect the diff;
6. verify the privacy invariant;
7. report changed files and verification results;
8. stop and wait for the next phase unless explicitly instructed otherwise.

Do not rewrite working components unnecessarily.

Do not silently change the architecture because a library/model is inconvenient.

## 20. Git Discipline

Keep commits small and meaningful.

Before committing:
- inspect `git status`;
- inspect `git diff`;
- run relevant tests/build;
- ensure no secrets or generated sensitive artifacts are staged.

Never commit:
- `.env`;
- API keys;
- credentials;
- token maps;
- raw sensitive screenshots;
- local model caches that are not intended for the repo;
- machine-specific temporary files.

Suggested commit style:

```text
feat(extension): add local DOM privacy tokenizer
feat(server): add sanitized context endpoint
feat(agent): add validated action executor
test(privacy): add PII redaction cases
docs: update architecture and API contract
```

## 21. Documentation Rules

When implementation changes architecture or an API:
- update the relevant documentation;
- keep examples synchronized with the code;
- clearly mark planned/unimplemented features;
- record benchmark results separately from targets.

Do not copy large sections of the research report into source files.

## 22. What Claude Must Do Before Major Work

Before implementing a new phase, inspect:

```text
CLAUDE.md
docs/
existing source code
existing tests
package.json / pyproject.toml / equivalent build files
manifest.json
```

Then state:
- what already exists;
- what the phase requires;
- what files will change;
- any architecture/security concern.

## 23. Current Documentation Files

The supplied source materials are stored in `docs/`:

- `SIH26171_ByteForce-v2(1).pdf` — SIH internal-hackathon PPT/submission content.
- `some context regarding this PS research(3).txt` — combined SIH PS + research notes.
- `Deep Research Prompt — SIH Problem Statement 26171(3).md` — original deep-research requirements/questions.
- `Privacy-Preserving Agentic Browser Workflow (3)(1).png` — proposed architecture/workflow visual.

Read these when detailed background is needed. Do not assume every claim in the research notes is verified.

## 24. Important Research Caveats

The supplied research contains useful design ideas but also speculative or potentially outdated statements. Examples include exact model sizes/latencies, browser support, competitor capabilities, and claims such as “100% safe,” “0% privacy leak,” or specific percentage improvements.

Therefore:
- verify technology behavior against current official documentation when implementation depends on it;
- benchmark our own system before making performance claims;
- do not state competitor limitations as facts without evidence;
- distinguish SIH requirements from our proposed design;
- distinguish prototype behavior from production guarantees.

## 25. Definition of Done

A phase is complete only when:
- requested functionality works;
- existing functionality is not unnecessarily broken;
- privacy invariants hold;
- relevant tests/build/typechecks pass;
- no secrets are exposed;
- changed files are understood;
- the implementation matches the documented contract;
- the result is reproducible from the repository.

**Primary principle: build a real, testable RedactVision Agent — not a demo that only looks correct.**
