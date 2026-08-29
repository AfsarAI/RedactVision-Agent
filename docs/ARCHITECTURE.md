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

The visual workflow image supplied with the project illustrates this separation between the on-device trusted zone and the server zone.
