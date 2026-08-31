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
             +--> Visual page scan (screenshot + DOM)
             |
             v
     LOCAL PRIVACY FIREWALL
             |
             +--> Local LLM masker (Hugging Face model)
             |       decides WHAT to mask and WHAT token to use
             +--> Regex / heuristic detectors (fallback)
             +--> Optional local NER/OCR
             +--> Optional local CV (face / doc / card)
             |
             v
     SEMANTIC TOKENIZATION
             |
             +--> generic tokens: [FIELD_TYPE_N]
             |    e.g. [NAME_01], [EMAIL_01], [PAN_CARD_01],
             |         [APP_ID_01], [PHONE_01], [PASSWORD_01]
             +--> LOCAL TOKEN MAP (never transmitted)
             +--> Prompt-profile extraction (name/email/etc
             |    parsed from the user's natural-language prompt)
             |
             v
      === NETWORK BOUNDARY ===
             |
             v
       FASTAPI GATEWAY
             |
             v
      SERVER-SIDE LLM
             |
             |  receives:
             |    - sanitized DOM (generic tokens)
             |    - user_task
             |    - [PROFILE:name] / [PROFILE:email] hints
             |    - action_history
             |  returns:
             |    - structured JSON action (click/type/scroll/navigate/wait/done)
             |    - value may be a literal, a page token [EMAIL_01],
             |      or a local-profile token [PROFILE:pan_card]
             |
             v
       STRUCTURED ACTION
             |
             v
      === NETWORK BOUNDARY ===
             |
             v
       LOCAL ACTION VALIDATOR / POLICY ENGINE
             |
             v
      LOCAL TOKEN RESOLUTION
             |    1. Page-local token map (if value came from the page)
             |    2. Session profile (auto-extracted from user prompt)
             |    3. Selected saved profile
             |    4. MISSING → prompt user in chat ← new
             v
      BROWSER EXECUTOR
             |
             v
          NEW PAGE STATE
             |
             +--------> re-perceive / re-sanitize / re-reason
```

## Perception Strategy (visual-first)

The agent perceives the page **visually first** — it captures a screenshot of
the visible viewport and scans it, exactly the way Perplexity Comet moves
cursors, clicks, and types. DOM extraction is used only as a secondary signal
to obtain stable selectors and form field semantics when available.

The priority order is:

1. **Visual scan** — screenshot the viewport; OCR + local LLM tells the agent
   what fields are on the page and what each field asks for.
2. **DOM semantics** — when present, use `input[name]`, `id`, `placeholder`,
   `aria-label` to pick the _exact_ element to type into.
3. **Semantic fallback** — if a selector does not match, locate the field by
   label / surrounding text / form layout.
4. **Coordinates** — last resort, only when nothing else works.

The agent **moves the cursor, clicks, and types keyboard events** to simulate
a real user. It does not call `el.value = …` directly except as a final
mechanism after focus/selection; every action goes through the real input
pipeline (`focus → selection → insertText → input/change events`).

## ⚠️ Implementation Status — Read Before Claiming Capability

The architecture above is the **target**. The **current implementation** is partial. This section is the source of truth for what actually runs.

### What is ACTIVE in the default agent flow

```text
1. Capture viewport screenshot (background tabs.captureVisibleTab)
2. PerceptionPipeline(OCR / NER / CV with graceful fallback)
3. LOCAL LLM masker (client-llm.ts / on-device-model.ts)
      decides which values to mask and which generic token to assign
4. PrivacyFirewall.sanitizePage()
      replaces sensitive values with generic semantic tokens
5. Build sanitized context (tokens + safe metadata + [PROFILE:*] hints)
6. POST /llm/plan to server
7. Server returns structured action
8. Validate → resolve tokens locally → execute
```

The local LLM masker is the primary decision-maker for masking; regex /
heuristic detectors remain as a fast fallback. If the local model cannot be
loaded, the agent degrades to regex-only masking and continues.

### Local Perception Modules

| Layer                | File                                                  | Library                             | Status                               |
| -------------------- | ----------------------------------------------------- | ----------------------------------- | ------------------------------------ |
| Screenshot capture   | `perception/screenshot-capture.ts`                    | Background `tabs.captureVisibleTab` | Active                               |
| Local OCR            | `perception/ocr-engine.ts`                            | Tesseract.js                        | Optional / graceful                  |
| Local NER            | `perception/ner-engine.ts`                            | Transformers.js                     | Optional / graceful                  |
| Local CV / Vision    | `perception/cv-engine.ts`                             | Transformers.js                     | Optional / graceful                  |
| **Local LLM masker** | `llm/client-llm.ts` + `perception/on-device-model.ts` | Hugging Face model                  | Active — drives masking decisions    |
| Evidence fusion      | `perception/perception-pipeline.ts`                   | Orchestrator                        | Active in `AgentSession.runPrompt()` |
| Sensitive data map   | `perception/sensitive-data-map.ts`                    | Local schema                        | Populated locally; never sent raw    |
| Visual redaction     | `privacy/visual-redaction-engine.ts`                  | Canvas blur/mask/pixelate           | Available                            |

## Planner Invariant

The action-planning flow has **one** planner and **one** automatic fallback:

1. **Server LLM** is the sole action planner. It receives only the
   sanitized DOM (with generic tokens like `[PAN_CARD_01]`) and returns
   a structured action.
2. If the server is unreachable, times out (> 120 s), returns a 4xx/5xx
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

- the server URL (no API key — see below);
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
- raw screenshots;
- the complete local token map;
- the local LLM model and its inference;
- profile data (encrypted at rest);
- all action execution.

The server may receive:

- sanitized DOM with generic tokens;
- `[PROFILE:field]` capability tokens;
- non-sensitive element metadata;
- sanitized visual-region summaries;
- user task text (after privacy filtering).

The server must **never** receive:

- the local token map;
- original sensitive values;
- raw screenshots containing PII;
- profile values in the clear;
- credentials or authentication secrets.

## Grounding (visual-first)

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
