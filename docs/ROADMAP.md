# RedactVision Agent — Development Roadmap

## Project Goal

Build a working privacy-preserving browser agent for SIH Problem Statement SIH26171.

The system must allow a user to give a natural-language browser task through the RedactVision Agent Chrome Extension.

Sensitive information must be detected and protected locally on the user's device before any context crosses the network boundary.

The server may reason over sanitized/tokenized context and return structured browser actions.

The browser must validate and execute those actions locally.

The final prototype must visibly demonstrate:

User Prompt
→ Local Perception
→ Local Privacy Protection
→ Sanitized Context
→ Server Reasoning
→ Structured Action
→ Local Validation
→ Browser Execution
→ Updated Page State

---

# Phase 0 — Development Environment

## Objective

Prepare a reproducible development environment for the extension, backend, testing and Git workflow.

## Components

- Ubuntu development environment
- Google Chrome
- Node.js
- npm
- TypeScript
- esbuild
- Python
- virtual environment
- FastAPI
- Uvicorn
- WebSocket support
- Git/GitHub

## Definition of Done

- Extension toolchain works.
- TypeScript compilation works.
- Extension build works.
- Python virtual environment works.
- FastAPI dependencies can be installed.
- Git repository is initialized.
- No secrets are committed.

---

# Phase 1 — Chrome Extension Foundation

## Objective

Create the Manifest V3 extension foundation.

## Components

- manifest.json
- content script
- service worker
- popup
- extension assets
- build configuration

## Initial Structure

extension/

    manifest.json

    src/
        background/
        content/
        popup/
        privacy/
        perception/
        executor/

## Definition of Done

The extension can be loaded through Chrome's developer extension page.

The content script executes successfully on the test page.

The service worker starts successfully.

The extension can be rebuilt using the documented npm command.

---

# Phase 2 — DOM Perception

## Objective

Extract useful semantic information from the current webpage.

## Extract

- URL
- page title
- tag
- id
- classes
- type
- name
- placeholder
- aria-label
- visible text
- form values
- selectors
- interactive elements

## Important Rule

DOM extraction happens locally.

Raw extracted DOM must not automatically be transmitted to the server.

## Definition of Done

A controlled local test page can be inspected and converted into structured DOM context.

---

# Phase 3 — Local Privacy Firewall

## Objective

Detect sensitive information locally before network transmission.

## Detection Layers

### Layer 1 — DOM/context rules

Detect sensitive fields using:

- input type
- autocomplete
- name
- id
- semantic attributes

### Layer 2 — Pattern detection

Detect:

- email
- phone
- credit/debit card numbers
- Aadhaar
- API keys
- tokens
- other configured sensitive patterns

### Layer 3 — Entity/context detection

Detect contextual entities such as:

- person names
- organizations
- locations

### Layer 4 — Local visual detection

Reserved for later visual perception.

## Definition of Done

Sensitive values are detected locally.

Normal UI instructions such as:

"Enter your full name"

must not be incorrectly classified as PII.

---

# Phase 4 — Semantic Tokenization

## Objective

Replace sensitive values with reversible semantic tokens while preserving page meaning.

## Examples

Rahul Kumar

→ [PERSON_01]

rahul@gmail.com

→ [EMAIL_01]

9876543210

→ [PHONE_01]

MySecretPassword123

→ [PASSWORD_01]

## Local Token Map

The browser maintains:

token → original value

Example:

[EMAIL_01]
→ rahul@gmail.com

## Security Rule

The token map is LOCAL ONLY.

It must never be sent to the server.

It must never be logged to production logs.

## Definition of Done

The sanitized DOM preserves useful semantics while removing raw sensitive values.

---

# Phase 5 — Agent Popup / User Interface

## Objective

Build the first complete user-facing RedactVision Agent interface BEFORE server/VLM development continues.

This is a mandatory milestone.

The user must be able to interact with the browser agent directly through the extension UI.

## UI Concept

The extension should feel like an AI browser agent, not a generic Chrome settings popup.

Use an agentic visual identity:

- RedactVision Agent logo/icon
- clean compact panel
- agent status indicator
- prompt input
- send button
- processing state
- task progress
- privacy status
- sanitized-data summary
- server-boundary summary
- action status
- completion state

## User Interaction

The popup must contain:

### Header

RedactVision Agent

Status:

- Ready
- Analyzing
- Protecting
- Thinking
- Executing
- Completed
- Error

### Prompt Area

Example:

"Fill the profile form and submit it."

### Send Button

Starts the agent task.

### Processing State

Show an agentic processing indicator.

Example:

Analyzing page...

Protecting sensitive data...

Preparing sanitized context...

Waiting for agent...

Validating action...

Executing...

### Privacy Summary

Show what the local privacy engine detected.

Example:

Protected locally:

✓ PERSON
✓ EMAIL
✓ PHONE
✓ PASSWORD

### Sanitization Summary

Show:

Original:

rahul@gmail.com

Sanitized:

[EMAIL_01]

Do NOT expose raw values unnecessarily in production UI.

For the prototype, a controlled developer/privacy inspection view may show them locally.

### Network Privacy View

Show explicitly:

Server receives:

- page structure
- sanitized values
- semantic tokens
- allowed metadata

Server does NOT receive:

- raw email
- raw phone
- raw password
- local token map

### Agent Action View

Example:

Agent decision:

CLICK

Target:

#submit-btn

Confidence:

98%

Then:

✓ Locally validated

✓ Executed

## Important Architecture Rule

The popup UI must NOT contain the token map as part of any server request.

The popup communicates with the extension's local service worker/content-script architecture.

## Definition of Done

The user can:

1. Open the RedactVision Agent popup.
2. Enter a natural-language task.
3. Submit the task.
4. See processing state.
5. See local privacy analysis.
6. See sanitized-data information.
7. See agent status.
8. See action status.
9. See completion/error state.

At this phase the server/VLM may still be mocked.

The complete UI must work locally before connecting the real backend.

---

# Phase 6 — Local Agent Task State Machine

## Objective

Create a reliable local orchestration state machine.

## States

IDLE

→ ANALYZING

→ SANITIZING

→ READY_TO_SEND

→ WAITING_FOR_AGENT

→ ACTION_RECEIVED

→ VALIDATING

→ EXECUTING

→ COMPLETED

or

→ ERROR

## Definition of Done

The popup and extension components share a consistent task state.

The UI always reflects the actual agent state.

No action is executed without passing through validation.

---

# Phase 7 — Secure Client/Server Transport

## Objective

Create the FastAPI WebSocket gateway.

## Flow

Chrome Extension

→ sanitized payload

→ WebSocket

→ FastAPI

## Security Boundary

Only sanitized data may cross the network boundary.

The following must NEVER be transmitted:

- raw PII
- local token map
- original sensitive values

## Development Server

Initially use a mock agent response.

Example:

{
  "action": "click",
  "target_selector": "#submit-btn",
  "confidence": 0.98
}

## Definition of Done

- WebSocket connection works.
- Sanitized payload arrives at server.
- Token map remains client-side.
- Network inspection confirms the privacy boundary.
- Popup shows connection/processing state.

---

# Phase 8 — Structured Agent Reasoning

## Objective

Introduce the server-side reasoning layer.

The server receives sanitized context and determines the next browser action.

## Input

Sanitized page context.

## Output

Strict structured JSON.

Example:

{
  "action": "click",
  "target_selector": "#submit-btn",
  "confidence": 0.98
}

Possible actions:

- click
- type
- scroll
- navigate
- wait

## Important Rule

The server does not directly control the browser.

It only proposes an action.

---

# Phase 9 — Local Action Validation

## Objective

Validate every server-generated action locally.

## Validation

Check:

- action type
- target existence
- selector validity
- element visibility
- allowed operation
- task context
- confidence threshold

## High-Risk Actions

Require confirmation where appropriate:

- payment
- purchase
- account deletion
- sending messages
- external submissions
- irreversible actions

## Definition of Done

No server action reaches the browser executor without local validation.

---

# Phase 10 — Browser Action Executor

## Objective

Execute validated actions inside the browser.

## Supported Actions

### Click

Find target and click.

### Type

Resolve token locally if required.

Example:

[EMAIL_01]

→ local token map

→ rahul@gmail.com

→ type into browser

### Scroll

Scroll to target or direction.

### Navigation

Navigate only according to policy.

### Wait

Wait for page/state changes.

## Critical Privacy Rule

Sensitive values may be restored ONLY locally at execution time.

They must never be sent to the server merely because the agent needs to type them.

---

# Phase 11 — Feedback Loop

## Objective

Make the agent iterative rather than one-shot.

## Flow

Action

→ Browser changes

→ Capture new page state

→ Extract DOM/context

→ Re-run privacy firewall

→ Re-tokenize

→ Send sanitized updated state

→ Receive next action

→ Validate

→ Execute

→ Repeat

## Stop Conditions

- task completed
- user cancellation
- maximum step count
- unsafe action
- agent error
- confidence too low

---

# Phase 12 — Local Visual Perception

## Objective

Add lightweight on-device visual perception where DOM/semantic information is insufficient.

## Pipeline

Screenshot

→ local preprocessing

→ local model

→ visual elements/entities

→ sensitive-region detection

→ redacted visual context

## Technologies

Evaluate:

- WebGPU
- WebAssembly
- ONNX Runtime Web
- lightweight vision models

## Important Rule

Do not introduce a large model unnecessarily.

Prioritize:

- low memory
- low latency
- browser compatibility
- privacy
- deterministic behavior

---

# Phase 13 — Visual Redaction

## Objective

Protect sensitive information visible in screenshots.

## Examples

Face

→ blurred/masked

Credit card

→ redacted/tokenized

Sensitive text

→ replaced/masked

## Output

Sanitized screenshot/context that can safely be provided to the reasoning layer.

---

# Phase 14 — VLM Integration

## Objective

Integrate the selected server-side vision-language model.

Candidate architecture:

Chrome Extension

→ sanitized DOM

→ sanitized visual context

→ FastAPI/WebSocket

→ VLM

→ structured action

The exact model/serving stack must be selected based on available compute and prototype constraints.

Do not assume that a particular model or serving engine is available until it has been tested.

---

# Phase 15 — Security Hardening

## Objective

Protect the complete agent against unsafe behavior.

Implement:

- prompt-injection defenses
- action allowlists
- target validation
- permission policies
- confirmation policies
- origin validation
- message validation
- malformed-action handling
- rate limiting where appropriate
- sensitive-data logging prevention
- token-map isolation

## Threats

Test against:

- prompt injection
- malicious webpage instructions
- hidden elements
- deceptive buttons
- malicious selectors
- unauthorized navigation
- data exfiltration attempts

---

# Phase 16 — Benchmarking

## Objective

Measure the prototype against SIH evaluation requirements.

Track:

### Visual Context Accuracy

Measure perception quality.

### PII Precision / Recall

Measure sensitive-data detection.

### Redaction Precision

Measure whether sensitive regions are correctly protected.

### Client Resource Usage

Measure:

- CPU
- RAM
- GPU usage where applicable
- model memory

### End-to-End Latency

Measure:

Capture

→ Privacy processing

→ Network

→ Reasoning

→ Validation

→ Execution

Record actual measured values.

Do not claim target numbers as achieved results until benchmarked.

---

# Phase 17 — End-to-End Demo

## Objective

Create a deterministic demonstration suitable for SIH evaluation.

## Demo Flow

1. Open controlled test website.
2. Sensitive data is visible locally.
3. Open RedactVision Agent.
4. Enter natural-language task.
5. Agent analyzes the page.
6. Local privacy engine detects sensitive information.
7. Sensitive information is tokenized/redacted.
8. Popup displays privacy protection status.
9. Only sanitized context crosses the network.
10. Server/VLM reasons over sanitized context.
11. Structured action returns.
12. Popup displays the proposed action.
13. Local policy engine validates it.
14. Browser executes it.
15. Page state changes.
16. Agent captures the new state.
17. Feedback loop continues.
18. Task completes.
19. Popup displays final result.

---

# Phase 18 — Demo / UI / Reliability Hardening

## Objective

Make the prototype presentation-ready.

Improve:

- popup UI
- agent icon
- animations
- processing indicators
- privacy visualization
- error states
- loading states
- connection status
- action history
- developer/privacy inspection panel

The UI must communicate the core innovation visually:

"Your data stayed on your device."

---

# Phase 19 — Git / Documentation / Release

## Objective

Prepare a reproducible repository.

Maintain:

- README
- architecture documentation
- setup instructions
- API contract
- security model
- benchmark results
- demo instructions
- environment example
- Git history

Never commit:

- API keys
- passwords
- `.env`
- `.venv`
- node_modules
- private credentials
- local token maps

---

# Agent Development Rule

Claude must NOT blindly implement the entire roadmap in one operation.

For every phase:

1. Inspect the existing implementation.
2. Read the relevant documentation.
3. Identify the exact scope of the phase.
4. Implement only that phase.
5. Do not rewrite working components unnecessarily.
6. Run type checks.
7. Run tests.
8. Build the project.
9. Verify the result.
10. Report changed files.
11. Report remaining issues.
12. Wait for approval before proceeding to the next major phase.

A phase is complete only when its Definition of Done is satisfied.

Never mark a feature as working without actually testing it.

---

# Current Project Status

Completed:

- Phase 0 — Development Environment
- Phase 1 — Chrome Extension Foundation
- Phase 2 — DOM Perception
- Phase 3 — Local Privacy Firewall
- Phase 4 — Semantic Tokenization
- Phase 5 — Agent Popup / User Interface (original)
- Phase 6 — Local Agent Task State Machine
- Phase 7 — Secure Client/Server Transport (FastAPI WebSocket)
- Phase 8 — Agentic Loop & Action Planning (chat UI, deterministic planner, agent session)
- **Phase 9–12 (incremental) — LLM-backed agent**
  - Phase 9 — Local action validation (in `ActionExecutor.validate()`)
  - Phase 10 — Browser action executor (click/type/scroll/select/wait, token resolution)
  - Phase 11 — Multi-iteration feedback loop (max 5 iterations, respects `done` flag)
  - Phase 12 — Reasoning backend abstraction with one planner path:
    - **Server-side**: OpenAI-compatible (Groq by default) at `POST /llm/plan`
    - **On-device privacy model**: Transformers.js + Qwen2.5-0.5B-Instruct (q4) with WebGPU/WASM auto-detect for local sanitization assistance only
  - Settings UI: configure server URL, local model id, privacy controls, test connection
  - All 24 client smoke tests + 12 server smoke tests pass

Current priority:

- Phase 13 — Visual redaction (image-based sensitive content)
- Phase 14 — VLM integration (multi-modal server reasoning)
- Phase 15 — Security hardening (allowlists, prompt-injection defense)

Do NOT mark future functionality as completed unless it actually works.
