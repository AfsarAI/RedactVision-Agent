# RedactVision Agent — Architecture

## Logical Flow

```text
                    USER
                     |
                     v
              ACTIVE BROWSER TAB
                     |
                     v
          +-----------------------+
          | Manifest V3 Extension |
          +-----------------------+
             |       |        |
             |       |        +--> Popup / Policy UI
             |       |
             |       +----------> Background Service Worker
             |
             v
        Content Script
             |
             +--> DOM / safe element metadata
             |
             +--> visual state when required
             |
             v
     LOCAL PRIVACY FIREWALL
             |
             +--> DOM semantic detector
             +--> regex / heuristics
             +--> optional local NER/OCR
             +--> optional local CV (on-device perception model)
             |
             v
     REDACTION + TOKENIZATION
             |
             +--> sanitized context
             |
             +--> LOCAL TOKEN MAP (never transmitted)
             |
             v
      === NETWORK BOUNDARY ===
             |
             v
       FASTAPI GATEWAY
             |
             v
      SERVER-SIDE VLM/LLM
             |
             v
       STRUCTURED ACTION
             |
             v
      === NETWORK BOUNDARY ===
             |
             v
       LOCAL VALIDATOR
             |
             +--> schema check
             +--> target check
             +--> risk/policy check
             +--> confirmation if required
             |
             v
      LOCAL TOKEN RESOLUTION
             |
             v
      BROWSER EXECUTOR
             |
             +--> click
             +--> type
             +--> scroll
             +--> navigate
             +--> wait
             |
             v
          NEW PAGE STATE
             |
             +--------> re-perceive / re-sanitize / re-reason
```

## ⚠️ Implementation Status — Read Before Claiming Capability

The architecture above is the **target**. The **current implementation** is partial. This section is the source of truth for what actually runs.

### What is ACTIVE in the default content-script flow (`content.ts` lines 39–49)

```text
extractPageDOM()  →  PrivacyFirewall.sanitizePage()  →  sanitizedPageDOM  →  /llm/plan
                       ├── DOM semantics (Layer 1)
                       └── regex/heuristics (Layer 2)
```

That is the entire active pipeline. DOM text only.

### What EXISTS in source but is NOT wired (modules available, not called)

| Layer | File | Library | Status |
|---|---|---|---|
| Screenshot capture | `perception/screenshot-capture.ts` | Chrome `tabs.captureVisibleTab` via background | Module only, not invoked |
| Local OCR | `perception/ocr-engine.ts` | Tesseract.js | Module only, not invoked |
| Local NER | `perception/ner-engine.ts` | Transformers.js | Module only, not invoked |
| Local CV / Vision | `perception/cv-engine.ts` | Transformers.js (face / ID / card / signature detection) | Module only, not invoked |
| Evidence fusion | `perception/perception-pipeline.ts` | Orchestrator: DOM + OCR + NER + CV in parallel | Module only, not invoked |
| Sensitive data map | `perception/sensitive-data-map.ts` | Schema for fused output | Schema only, not populated by default |
| Visual redaction | `perception/visual-redaction-engine.ts` | Blur / mask / box over sensitive image regions | Module only, not integrated |

### Consequence (must not be hidden)

Sensitive information rendered **only in images, canvas, screenshots, or other visual elements** (faces, cards, document photos, hidden rendered text, custom components) is **NOT detected or redacted** by the current default pipeline. Such data is not in the DOM, so the DOM-only path cannot see it.

**Privacy invariant §4.1 ("raw sensitive data must not cross the network boundary") is currently enforced only for DOM-text PII, not for visual PII.** Until the perception pipeline is wired into `content.ts` (so that screenshot → OCR + CV + NER → fusion → visual redaction runs before any server call), this gap remains.

### What MUST change to close the gap

`content.ts` must invoke `PerceptionPipeline` before calling `/llm/plan`:

1. `captureViewportScreenshot()` → image
2. In parallel:
   - DOM extraction + privacy firewall (current path)
   - OCR over the screenshot
   - CV detection (faces / cards / documents)
   - NER over OCR text + DOM text
3. `EvidenceFusion` produces a `SensitiveDataMap` keyed by region, type, confidence
4. Apply visual redaction (blur/mask/box) over each region in the image
5. Apply DOM masking for the same items
6. Build a `SanitizedContext` containing sanitized DOM + sanitized image crops + safe OCR text
7. Send only the sanitized context to the server

Until that is implemented and tested end-to-end, every external claim (README, docs, demo) must label visual redaction as **partial / experimental**.

## Planner Invariant

The action-planning flow has **one** planner and **one** automatic fallback:

1. **Server LLM** is the sole action planner. It receives only the
   sanitized DOM (with semantic tokens like `[EMAIL_01]`) and returns
   a structured action.
2. If the server is unreachable, times out (> 5 s), returns a 4xx/5xx
   status, or returns an unparseable action, the client
   **automatically** falls back to the local deterministic rule-based
   planner (`extension/src/agent/action-planner.ts`). The user does
   not configure this — it is implicit and always on.
3. The on-device model (Transformers.js) is **not** a planner. It is
   a perception / sanitization helper inside the Privacy Firewall,
   used to detect faces, canvas-rendered PII, image-only sensitive
   data, etc. before any sanitized context crosses the network
   boundary. Its output becomes part of the local token map.

The user-configurable Settings surface exposes only:

- the server URL and (optional) API key for the planning endpoint;
- the on-device model id used by the Privacy Firewall.

There is no "reasoning backend" toggle. There is no "force offline"
toggle. The routing is fixed.

## Why the extension never holds API keys

The extension's Settings surface exposes only the **server URL** and
the **on-device model id**. It does **not** expose a provider API key
field, and it never accepts one.

Provider API keys (Gemini, Groq, OpenRouter, NVIDIA NIM, OmniRoute,
Hugging Face) live exclusively on the **server side**, in
`server/.env` and read by the FastAPI process. The browser only ever
talks to the local FastAPI server — never directly to OpenAI, Gemini,
Groq, or any external LLM provider.

Concretely:

- The user's chrome.storage.local config contains only
  `{ serverUrl, onDeviceModel }`. There is no key field.
- The server, on receiving a `/llm/plan` request, picks up the
  provider key from its own environment and authenticates with the
  upstream LLM on the user's behalf.
- This keeps provider keys out of the extension bundle (which is
  shipped to every user and inspected by the Chrome Web Store), out
  of the browser's storage (which is more accessible to page-side
  scripts than people realize), and out of any debug log or
  exception trace that the extension might produce.

The background service worker also centralizes network calls so that
content scripts — which run in the page's CORS-bound origin — never
have to make privileged fetches themselves. The two message types
are `RV_PING_SERVER` and `RV_PLAN_ACTION` (see
`extension/src/background/service-worker.ts`).

## Trusted Zone

The client owns:
- raw DOM;
- raw visual state;
- sensitive values;
- token map;
- redaction decisions;
- local policy;
- final execution.

## Untrusted/remote zone

The server receives only sanitized information.

The server may reason about tokens such as `[PERSON_01]` or `[EMAIL_01]`, but must not receive the token-to-original-value mapping.

## Grounding

Use a hierarchy:
1. stable DOM ID/selector;
2. semantic element attributes;
3. accessibility role/name;
4. geometry/coordinates as fallback.

## Visual Context

Do not automatically send a full screenshot. Prefer:
- sanitized structured DOM;
- accessibility/role metadata;
- bounding boxes;
- OCR text;
- sanitized image crops when necessary.

**Current default behaviour:** Only sanitized DOM is sent. Screenshots are NOT captured and visual redaction is NOT applied unless the perception pipeline is explicitly invoked (which the current `content.ts` does NOT do).

The visual workflow image supplied with the project illustrates this separation between the on-device trusted zone and the server zone.

