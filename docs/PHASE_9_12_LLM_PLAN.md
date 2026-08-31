# Phase 9 + 10 + 11 + 12 (incremental) — LLM-based Agent

## What changed

The agent now supports a **server-only action planner** plus a local privacy helper:

1. **Server-side LLM planner** — calls the local FastAPI server at `POST /llm/plan`.
2. **On-device privacy/perception helper** — can load `onnx-community/Qwen2.5-0.5B-Instruct` (q4) in the browser via `@huggingface/transformers`. It is not an action planner.

The extension configuration exposes server URL and local model id. Provider API keys stay only in the server `.env`.

## Architecture

```
USER PROMPT
   ↓
AgentSession.runPrompt(prompt)            ← multi-iteration loop
   ↓
   iteration = 0
   while iteration < MAX_ITERATIONS:
       DOM extract + local visual perception → Privacy Firewall → sanitize
       LLMPlanner.plan(prompt, sanitizedDOM, history)
         └─ server-llm (POST /llm/plan)
       validate → execute → verify
       if llmAction.done: break
       iteration++
```

The LLM output includes a `done: bool` flag so the LLM can signal task completion. The orchestrator respects this and breaks the loop.

## Files added

| File | Purpose |
|------|---------|
| `extension/src/llm/action-schema.ts` | Shared TS types for the LLM action (action/target/value/direction/amount/confidence/done) + validator |
| `extension/src/llm/client-llm.ts` | Transformers.js wrapper for local privacy/perception assistance |
| `extension/src/llm/llm-planner.ts` | Server-only planner orchestrator, config persistence |
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

The `@huggingface/transformers` package is an `optionalDependencies` entry. It is **not** installed by default. To enable optional on-device privacy/perception assistance:

```bash
cd extension
npm install @huggingface/transformers
```

The first time local inference runs, the extension downloads `onnx-community/Qwen2.5-0.5B-Instruct` from Hugging Face. The model is cached in IndexedDB and persists across browser restarts.

If WebGPU is available, the model runs on GPU (~1-3s per response). Otherwise it falls back to ONNX WASM (CPU, 5-15s per response).

### 3. Settings UI

Open the extension popup. The dashboard exposes:

- **Server URL** (default `http://127.0.0.1:8001`)
- **On-device model** (default `onnx-community/Qwen2.5-0.5B-Instruct`)
- **Encrypted local personal profiles**
- **Test connection** button — hits `<server>/llm/health` and shows the configured model

Settings are persisted per-extension via `chrome.storage.local`.

## Privacy guarantees

- The server **never** receives the local token map.
- The server receives only the **sanitized** DOM. The client replaces sensitive values with tokens like `[EMAIL_01]` before sending.
- The server re-validates incoming payloads via `validate_action_request` and rejects if raw PII is detected.
- Provider API keys are stored only in the server environment (`.env`). The extension stores the server URL, never upstream LLM provider keys.
- The on-device model runs entirely in the browser. The model file is fetched from `huggingface.co` on first use; nothing else leaves the device.
- All LLM responses pass through the `validateLLMAction` shape check before reaching the executor. Invalid actions are rejected without execution.

## Testing

### Server tests (12 tests, all pass)

```bash
cd server
source ../.venv/bin/activate
python tests/test_llm_planner.py
```

Covers: JSON parsing (clean, fenced, with chatter), shape validation, prompt template, unavailable-server path, health endpoint.

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
