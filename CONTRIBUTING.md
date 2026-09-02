# Contributing to RedactVision Agent

> **SIH 26171 — On-device Visual Perception for Light-weight Browser Agents**  
> **Team:** ByteForce &nbsp;|&nbsp; **Organization:** Indian Space Research Organisation (ISRO)

Thank you for your interest in contributing to **RedactVision Agent**! We welcome contributions from developers, researchers, and security specialists to help advance privacy-preserving autonomous browser automation.

---

## 📜 Table of Contents

1. [Core Privacy Principles](#-core-privacy-principles)
2. [Development Environment Setup](#-development-environment-setup)
3. [Architecture & Source-of-Truth Hierarchy](#-architecture--source-of-truth-hierarchy)
4. [Development Workflow](#-development-workflow)
5. [Coding & Style Standards](#-coding--style-standards)
6. [Commit Message Guidelines](#-commit-message-guidelines)
7. [Pull Request Checklist](#-pull-request-checklist)
8. [Reporting Bugs & Requesting Features](#-reporting-bugs--requesting-features)

---

## 🛡️ Core Privacy Principles

Before contributing code, please ensure you understand the project's non-negotiable security invariants:

1. **Zero Raw PII on Network**: Real sensitive data (emails, phones, passwords, names, IDs, credit cards) must never leave the browser.
2. **Client-Only Token Map**: The local token mapping (`[PERSON_01] -> "Real Name"`) must remain in client memory only.
3. **Encrypted Vault Storage**: User profile values must be encrypted using WebCrypto **AES-GCM (256-bit)** before writing to `chrome.storage.local`.
4. **Never Commit Secrets**: Do not commit `.env` files, API keys, credentials, or private test data. GitHub Push Protection is enabled.

---

## 🚀 Development Environment Setup

### Prerequisites

- **Node.js**: `v18.0.0` or higher
- **npm**: `v9.0.0` or higher
- **Python**: `3.10` or higher
- **Google Chrome** (or Chromium-based browser)

---

### Step 1: Fork & Clone

```bash
git clone https://github.com/AfsarAI/RedactVision-Agent.git
cd RedactVision-Agent
```

---

### Step 2: Set Up Python Backend

```bash
# Create virtual environment
python3 -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate

# Install dependencies in editable mode
pip install -r requirements.txt
```

Configure local environment variables:

```bash
cp .env.example .env
```

Add your development API keys to `.env` (Groq, OpenRouter, or local OmniRoute).

---

### Step 3: Build the Chrome Extension

```bash
cd extension
npm install
npm run build
```

Load unpacked in Chrome:

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (top right toggle).
3. Click **Load unpacked** and select the `extension/` folder (the directory containing `manifest.json`).

---

### Step 4: Run the Local Test Sandbox

In a separate terminal:

```bash
cd test-site
python3 -m http.server 8000
```

Start the backend server in another terminal:

```bash
start-server
# Or: uvicorn redactvision_server.main:app --reload --port 8001
```

Open `http://localhost:8000/` in Chrome to test the extension end-to-end.

---

## 🏗️ Architecture & Source-of-Truth Hierarchy

1. **`extension/src/` is the Source of Truth**:
   - Always edit TypeScript and CSS files inside `extension/src/`.
   - **Never manually edit `extension/dist/`** — `dist/` is generated build output and is gitignored.
   - Run `npm run build` after making changes in `extension/src/`.

2. **Backend Gateway (`server/redactvision_server/`)**:
   - `main.py`: FastAPI server routes and lifecycle management.
   - `llm.py`: Think-Before-Acting planner and validation loop logic.
   - `providers.py`: Multi-provider adapters (Groq, OpenRouter, OmniRoute).
   - `mock_agent.py`: Server-side defense-in-depth PII scanner.

---

## 🔄 Development Workflow

1. Create a descriptive feature branch from `main`:
   ```bash
   git checkout -b feat/your-feature-name
   # or for bugfixes: git checkout -b fix/issue-description
   ```
2. Implement your changes following project conventions.
3. Test the full loop locally:
   - Build extension: `cd extension && npm run build`
   - Run typechecks: `npm run typecheck`
   - Test server endpoints via `curl` or test suite.
4. Verify that no secrets or generated build artifacts (`dist/`, `.venv/`) are staged.

---

## 📐 Coding & Style Standards

### TypeScript / Frontend

- Strict mode is enforced (`tsconfig.json`). Ensure there are no implicit `any` types.
- Use explicit return types for exported functions and classes.
- Use async/await over raw promise chains for asynchronous browser flows.
- Wrap all Chrome messaging with context validity checks (`isExtensionContextValid()` / `safeSendMessage()`).

### Python / Backend

- Follow PEP 8 guidelines.
- Use Pydantic models for all request and response payloads (`server/redactvision_server/types.py`).
- Add type annotations (`typing.Optional`, `typing.Tuple`, `typing.Any`) to all functions.
- Handle provider timeouts and exceptions gracefully with structured error codes.

---

## 📝 Commit Message Guidelines

We follow the [Conventional Commits](https://www.conventionalcommits.org/) standard. Each commit message should be concise and structured:

```text
<type>(<scope>): <short summary>

[optional body explaining motivation and changes]
```

### Allowed Types:

- **`feat`**: A new feature or capability (e.g., `feat(executor): add CDP click support`).
- **`fix`**: A bug fix (e.g., `fix(privacy): prevent false-positive phone regex rejection`).
- **`docs`**: Documentation changes (e.g., `docs: update README with API reference`).
- **`perf`**: Performance and latency improvements (e.g., `perf(content): debounce DOM mutation observer`).
- **`refactor`**: Code changes that neither fix a bug nor add a feature.
- **`test`**: Adding or updating tests.
- **`chore`**: Maintenance, build toolchain, or dependency updates.

---

## ✅ Pull Request Checklist

Before submitting your Pull Request, verify the following:

- [ ] `npm run build` in `extension/` runs with **0 errors** (`tsc --noEmit` clean).
- [ ] No `.env`, API keys, or private data are committed or staged.
- [ ] No edits were made to generated directories (`extension/dist/`).
- [ ] Python server starts cleanly with `start-server` and passes `GET /health`.
- [ ] The change respects all core privacy invariants (raw PII never crosses network).
- [ ] PR description clearly explains the motivation, changes made, and testing steps.

---

## 🐛 Reporting Bugs & Requesting Features

- **Bug Reports**: Open an issue on GitHub using a clear title, reproduction steps, console logs, and browser/OS details.
- **Security & Privacy Vulnerabilities**: Please review [SECURITY.md](SECURITY.md) for private disclosure instructions. Do not open public issues for sensitive security exploits.

---

Thank you for contributing to the future of privacy-preserving browser automation! 🚀
