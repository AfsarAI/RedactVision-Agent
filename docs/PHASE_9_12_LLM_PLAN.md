# Phase 9 + 10 + 11 + 12 (incremental) — LLM-based Agent

## What changed

The agent now supports **three reasoning backends**:

1. **Server-side LLM** — calls an OpenAI-compatible Chat Completions endpoint (Groq by default, also works with OpenRouter, Together, llama.cpp server, vLLM with `--openai-compatible`).
2. **On-device LLM** — runs `onnx-community/Qwen2.5-1.5B-Instruct` (q4) in the browser via `@huggingface/transformers`. Auto-detects WebGPU.
3. **Local rules** — the original deterministic keyword planner (always available, used as fallback).

The selected backend is configurable from a Settings panel in both the popup and the in-page panel.

## Architecture

```
USER PROMPT
   ↓
AgentSession.runPrompt(prompt)            ← multi-iteration loop
   ↓
   iteration = 0
   while iteration < MAX_ITERATIONS:
       DOM extract → Privacy Firewall → sanitize
       LLMPlanner.plan(prompt, sanitizedDOM, history)
         ├─ client-llm (Transformers.js)         ← only if enabled
         ├─ server-llm (POST /llm/plan)          ← only if configured
         └─ fallback rules (deterministic)       ← always available
       validate → execute → verify
       if llmAction.done: break
       iteration++
```

The LLM output includes a `done: bool` flag so the LLM can signal task completion. The orchestrator respects this and breaks the loop.

## Files added

| File | Purpose |
|------|---------|
| `extension/src/llm/action-schema.ts` | Shared TS types for the LLM action (action/target/value/direction/amount/confidence/done) + validator |
| `extension/src/llm/client-llm.ts` | Transformers.js wrapper with WebGPU detection, model download, IndexedDB cache |
| `extension/src/llm/llm-planner.ts` | Orchestrator (client → server → fallback), config persistence |
| `server/redactvision_server/llm.py` | OpenAI-compatible client (Groq) |
| `server/redactvision_server/planner_prompt.py` | System + user prompt templates |
| `server/tests/test_llm_planner.py` | Server-side smoke tests (12 tests, all pass) |

## Files modified

- `extension/src/agent/agent-session.ts` — uses LLMPlanner; multi-iteration loop (max 5)
- `extension/src/ui/chat-ui.ts` — Settings modal, new activity kinds (`llm_thinking`, `iteration_complete`)
- `extension/src/ui/chat-ui.css` — Settings modal + new activity styles
- `extension/src/popup/popup.ts` — wires settings panel, loads config
- `extension/src/content/content.ts` — same, for in-page panel
- `extension/manifest.json` — added `host_permissions` for `huggingface.co` and `cdn-lfs.huggingface.co`
- `extension/package.json` — `optionalDependencies` for `@huggingface/transformers`; build marks it external (so the bundle stays small until the user opts in)
- `server/redactvision_server/main.py` — added `GET /llm/health` and `POST /llm/plan`
- `server/redactvision_server/types.py` — added `PlanRequest` and `PlanResponse`
- `server/pyproject.toml` — moved `httpx` from dev to main deps

## How to use

### 1. Server-side LLM (Groq)

```bash
# In the server directory, with the venv active
export GROQ_API_KEY="gsk_..."
# Optional: pick a different model
export LLM_MODEL="llama-3.1-8b-instant"

cd /home/afsarai/SIH-26171-ByteForce/RedactVision-Agent/server
source ../.venv/bin/activate
uvicorn redactvision_server.main:app --port 8001 --host 127.0.0.1
```

The server's `/llm/health` will report `"configured": true` once the env var is set.

You can also use any OpenAI-compatible endpoint by setting `LLM_API_URL`:

```bash
export LLM_API_URL="https://api.openai.com/v1/chat/completions"
export LLM_MODEL="gpt-4o-mini"
export LLM_API_KEY="sk-..."
```

### 2. On-device LLM

The `@huggingface/transformers` package is an `optionalDependencies` entry. It is **not** installed by default. To enable the on-device backend:

```bash
cd extension
npm install @huggingface/transformers
```

The first time the user enables the "on-device" backend, the extension downloads `onnx-community/Qwen2.5-1.5B-Instruct` (~1GB) from Hugging Face. The model is cached in IndexedDB and persists across browser restarts.

If WebGPU is available, the model runs on GPU (~1-3s per response). Otherwise it falls back to ONNX WASM (CPU, 5-15s per response).

### 3. Settings UI

Click the ⚙ button in the popup header (or in the in-page panel). The modal exposes:

- **Backend**: Auto / Server / On-device / Local rules only
- **Server URL** (default `http://127.0.0.1:8001`)
- **API key** (stored in `chrome.storage.local`, never sent anywhere except the configured URL)
- **On-device model** (default `onnx-community/Qwen2.5-1.5B-Instruct`)
- **Test connection** button — hits `<server>/llm/health` and shows the configured model

Settings are persisted per-extension via `chrome.storage.local`.

## Privacy guarantees

- The server **never** receives the local token map.
- The server receives only the **sanitized** DOM. The client replaces sensitive values with tokens like `[EMAIL_01]` before sending.
- The server re-validates incoming payloads via `validate_action_request` and rejects if raw PII is detected.
- The API key is stored only in `chrome.storage.local` and is sent only to the user-configured server URL.
- The on-device model runs entirely in the browser. The model file is fetched from `huggingface.co` on first use; nothing else leaves the device.
- All LLM responses pass through the `validateLLMAction` shape check before reaching the executor. Invalid actions are rejected without execution.

## Testing

### Server tests (12 tests, all pass)

```bash
cd server
source ../.venv/bin/activate
python tests/test_llm_planner.py
```

Covers: JSON parsing (clean, fenced, with chatter), shape validation, prompt template, fallback path, health endpoint.

### Client tests (24 tests, all pass)

```bash
cd extension
node --experimental-strip-types test-agent.mjs
```

Covers: deterministic planner (11 cases), LLM action schema (9 cases), LLM→executor conversion (4 cases).

### Live integration test

With the server running and the extension loaded:

1. Open `http://localhost:8000/`
2. Click 🤖 bottom-right
3. Try prompts:
   - `fill the full name by "Afsar"` → field gets "Afsar" (LLM understands natural phrasing)
   - `scroll halfway down` → scrolls ~500px
   - `click the blue button at the bottom` → server LLM picks the best matching button
   - `fill the form and submit it` → multi-iteration loop fills all fields then clicks submit

## Known limitations

- **First on-device run is slow.** Model download ~1GB + warmup. After that, inference starts in 1-3s.
- **The 1.5B model is small.** It will make mistakes on complex phrasings. Use the server LLM (Groq) for higher quality.
- **Multi-iteration cap is 5.** Prevents runaway loops. Configurable in `agent-session.ts`.
- **No streaming output yet.** The LLM returns a single JSON object per iteration. Streaming can be added in a follow-up.
- **No screenshot / vision yet.** The fast path is DOM-only. The visual fallback architecture is reserved but not implemented.
- **In-page panel settings are not synced with the popup's settings in real time.** Both read from the same `chrome.storage.local`, but if you change settings in the popup, the in-page panel needs to be reopened (or a refresh listener added) to pick them up.

## What's next (Phases 13+)

- Phase 13 — Visual redaction (image-based sensitive content)
- Phase 14 — VLM integration (multi-modal server reasoning)
- Phase 15 — Security hardening (allowlist, prompt-injection defense, risk classification)
- Phase 16 — Benchmarking
- Phase 17 — End-to-end demo
- Phase 18 — UI hardening
- Phase 19 — Docs + release
