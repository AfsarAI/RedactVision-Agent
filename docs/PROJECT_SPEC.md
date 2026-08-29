# RedactVision Agent — Project Specification

## 1. Purpose

RedactVision Agent is a privacy-preserving browser automation agent for SIH26171, “On-device Visual Perception for Light-weight Browser Agents.”

The core idea is to keep sensitive perception and sanitization on the user's device while using server-side VLM reasoning only on sanitized context.

## 2. SIH Requirements

The prototype must demonstrate:
- a browser-side extension;
- local visual/screen perception using a lightweight CV model or equivalent;
- local dynamic sensitive-data detection and redaction;
- sanitized/anonymized context before network transmission;
- server-side LLM/VLM reasoning;
- structured actionable commands returned to the browser;
- local browser execution;
- at least one end-to-end browser task.

Official scoring weights:
- Visual-context accuracy: 25%
- Sensitive/PII detection precision + recall: 20%
- Redaction precision: 20%
- Client resource utilization: 20%
- End-to-end latency: 15%

## 3. Product Architecture

Client/trusted zone:
1. Capture page state: DOM + safe element metadata + visual context when needed.
2. Detect sensitive content locally.
3. Redact/replace sensitive values.
4. Create semantic tokens and keep the token map locally.
5. Build sanitized context.

Network boundary:
- transmit only sanitized context.

Server:
1. receive sanitized context;
2. understand the redaction/token scheme;
3. reason about the user task;
4. return structured JSON action.

Client:
1. validate action schema and target;
2. apply local risk policy;
3. resolve local tokens only if permitted;
4. execute browser action;
5. capture the next state and repeat.

## 4. Perception Strategy

Preferred strategy is hybrid:
- DOM structure for exact elements and fields;
- accessibility/semantic information where available;
- selective visual processing for canvas/images/visual-only UI;
- OCR only when visual text is not available from DOM;
- local vision models for visual PII/UI detection when required.

Avoid processing or transmitting full screenshots when structured or selective context is sufficient.

## 5. Privacy Engine

Detection layers:
1. DOM semantics: password inputs, autocomplete, names, IDs, placeholders, labels, ARIA/data attributes.
2. Regex/heuristics: email, phone, card/identifier-like patterns, tokens/keys where safely detectable.
3. Optional local NER: names/locations/etc. only when justified by measured value.
4. Optional OCR/vision: visual-only text, faces, cards/documents.

Redaction:
- semantic token replacement for textual PII;
- strong masking for passwords/credentials;
- local blur/masking for faces;
- selective bounding-box redaction for visual documents/cards;
- preserve non-sensitive structure and geometry.

## 6. Token Map

Example:

```text
Rahul              -> [PERSON_01]
rahul@gmail.com    -> [EMAIL_01]
9876543210         -> [PHONE_01]
MySecretPassword123-> [PASSWORD_01]
```

The mapping from token to original value is client-only.

The server can see `[EMAIL_01]` but cannot see `rahul@gmail.com`.

## 7. Agent Actions

Conceptual actions:
- click
- type
- scroll
- navigate
- wait

Actions must be structured JSON, never arbitrary code.

Targets should prefer stable IDs/selectors and semantic metadata. Coordinates are a fallback, not the primary grounding mechanism.

## 8. Safety

The webpage is untrusted input. The server is not trusted to execute commands directly.

Every returned action must pass:
- schema validation;
- allowed-action validation;
- target existence;
- visibility/interactability checks where applicable;
- confidence/risk checks;
- domain/policy checks;
- user confirmation when required.

High-risk operations such as payment, account deletion, sending messages, credential entry, or similarly consequential actions should require stricter controls.

## 9. Performance

Use:
- lazy loading;
- quantized lightweight models;
- WebGPU where available and measured to help;
- WASM fallback;
- event-driven inference;
- MutationObserver for relevant page changes;
- ROI processing;
- payload minimization;
- caching where safe.

All performance numbers in source research are targets until benchmarked. Never claim `<50ms`, `<300ms`, `<150MB`, `>95% recall`, etc. as achieved without measurements.

## 10. Current Prototype Baseline

The current local test page is:

`http://localhost:8000/`

Current verified behavior:
- content script loads;
- DOM is extracted;
- sensitive values are detected locally;
- sanitized DOM is produced;
- semantic tokens are generated;
- local token map is maintained.

Observed example tokens include `[EMAIL_01]`, `[PHONE_01]`, `[PASSWORD_01]`, and `[PERSON_01]`.

The next components must build on this baseline rather than replacing it unnecessarily.

## 11. Candidate Stack

Primary direction:
- TypeScript
- Chrome Manifest V3
- Content Script
- Background Service Worker
- Offscreen/worker execution when needed
- ONNX Runtime Web
- WebGPU + WASM fallback
- optional Transformers.js
- FastAPI
- WebSocket or HTTPS JSON as justified
- server-side VLM such as Qwen2.5-VL or another empirically suitable model
- vLLM/Ollama/other serving stack depending on deployment constraints

These are candidates. Implementation decisions must be validated against the actual browser/runtime and measured prototype needs.

## 12. Prototype Scope

Priority order:
1. reliable local privacy boundary;
2. deterministic sanitized DOM/context;
3. client-server communication;
4. structured action generation;
5. local validation and execution;
6. visual model integration for gaps that DOM cannot cover;
7. benchmark instrumentation;
8. polished SIH demo.

Do not attempt an unnecessarily broad autonomous browser product before the core privacy-preserving loop is reliable.
