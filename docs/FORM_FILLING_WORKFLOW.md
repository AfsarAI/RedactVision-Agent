# RedactVision Form-Filling Workflow

## Overview

This document describes the complete end-to-end flow for privacy-preserving form filling using saved local profiles.

```
User enters form task
        ↓
[Content Script]
  ├─ Extract page DOM locally
  ├─ Capture visible viewport through the background worker when available
  ├─ Run Privacy Firewall
  │   └─ Detect & tokenize sensitive values
  │      (name → [PERSON_01], email → [EMAIL_01], etc.)
  ├─ Build sanitized page context
  │   └─ Only semantic tokens + non-sensitive metadata
  └─ Send sanitized context to Agent Session
        ↓
[Agent Session]
  ├─ Call Server LLM with sanitized context
  │   └─ Server receives [PERSON_01], [EMAIL_01], never raw values
  ├─ Server reasons about fields to fill
  ├─ Server generates action JSON:
  │   {
  │     "action": "type",
  │     "target": "#email-field",
  │     "value": "[PROFILE:email]",    ← local profile token reference
  │     "confidence": 0.95
  │   }
  └─ Send action back to content script
        ↓
[Action Executor - LOCAL TOKEN RESOLUTION]
  ├─ Receive: type [EMAIL_01] into #email-field
  ├─ Validate action
  ├─ Resolve token [EMAIL_01] locally:
  │   1. Check page-local privacy token map first
  │      (if it was on the page, use that original value)
  │   2. Fall back to selected local profile:
  │      - Load selected profile from browser storage
  │      - Get email field from selected profile
  │      - Use that value
  ├─ Type the resolved email value into the field
  └─ Report success to UI
        ↓
User task continues
```

## Key Privacy Invariants

1. **Raw sensitive data never crosses the network boundary**
   - Before sending any context to server, the privacy firewall replaces all detected sensitive values with semantic tokens
   - Only the sanitized (tokenized) version is transmitted

2. **Original values stay on the device**
   - The page-local token map (page values → tokens) stays in browser memory, never sent to server
   - The selected profile (stored in `chrome.storage.local`) stays on the device, never sent to server

3. **Tokens resolve only during local execution**
   - When the server's action references a token, the extension resolves it locally
   - The action executor never sends the resolved value to the server

## Implementation Details

### 1. Privacy Firewall (Privacy Detection & Tokenization)

**File:** `extension/src/privacy/privacy-firewall.ts`

- Detects sensitive values in page DOM using:
  - Layer 1: DOM semantics (input type, name, id, placeholder, aria-label)
  - Layer 2: Regex/heuristics (email, phone, credit card patterns)
  - Layer 3: Local visual perception metadata from OCR/NER/CV when available

- Generates deterministic semantic tokens:

  ```
  "Shrijal Gupta" → [PERSON_01]
  "shrijal@example.com" → [EMAIL_01]
  "9876543210" → [PHONE_01]
  "MySecretPassword123" → [PASSWORD_01]
  ```

- Maintains internal token map (never sent to server):
  ```javascript
  {
    "[PERSON_01]": "Shrijal Gupta",
    "[EMAIL_01]": "shrijal@example.com",
    "[PHONE_01]": "9876543210"
  }
  ```

### 2. Agent Session & LLM Planning

**Files:**

- `extension/src/agent/agent-session.ts`
- `extension/src/llm/llm-planner.ts`
- `server/redactvision_server/main.py`

**Flow:**

```typescript
// Content script creates session
const session = new AgentSession({
  privacyFirewall: privacyFirewall, // ← passed here
});

// User enters task
const outcome = await session.runPrompt("Fill this job application form");

// Inside session.runPrompt():
// 1. Extract page DOM again (fresh perception)
// 2. Attempt local screenshot/OCR/NER/CV perception
// 3. Sanitize it with the privacy firewall
// 4. Build planning context with sanitized DOM + safe visual metadata
// 5. Call server LLM:
//    POST /llm/plan { sanitized_context, task, ... }
// 6. Server returns actions with token references
// 7. Validate and execute actions
```

### 3. Selected Profile & Token Resolution

**Files:**

- `extension/src/privacy/profile-store.ts`
- `extension/src/executor/action-executor.ts`

**Profile Storage:**

```typescript
export interface LocalProfileEntry {
  id: string;
  label: string;
  createdAt: number;
  values: {
    name?: string;
    email?: string;
    phone?: string;
    address?: string;
    company?: string;
    jobTitle?: string;
    password?: string;
  };
}
```

Profile values are encrypted locally before they are stored in `chrome.storage.local`.
The encrypted store key is `rv_local_profiles_v2`. A non-extractable AES-GCM key is
kept in IndexedDB (`redactvision-private-vault`) so profile data survives page reloads
and browser restarts without being stored as plaintext.

Profiles are generic key/value stores. Common keys like `name`, `email`, `phone`, and
`address` are supported, and users can also store fields like `pan_card`, `linkedin`,
`application_id`, or any other form-specific detail.

**Selected Profile Persistence:**

```typescript
// Stored in chrome.storage.local under rv_selected_profile_id
await setSelectedProfileId("profile-12345");
const selectedId = await getSelectedProfileId();
const profile = await getSelectedProfile();
```

**Token Resolution During Execution:**

```typescript
// In action-executor.ts, executeType() method:

let value = action.value ?? ""; // e.g., "[PROFILE:email]"

// Try 1: Resolve from page-local privacy token map
let resolved = privacyFirewall.resolveToken(value);
if (resolved) {
  value = resolved; // Use original from page if available
} else {
  // Try 2: Resolve from selected encrypted local profile
  resolved = await resolveTokenFromProfile(value);
  if (resolved) {
    value = resolved; // Use profile value as fallback
  } else {
      throw new Error("Ask the user for the missing/ambiguous field");
  }
}

// Now type the resolved original value into the field
el.value = value;
el.dispatchEvent(new Event("input", { bubbles: true }));
```

## Step-by-Step Usage

### Step 1: Save a Profile

1. Open the extension popup (`chrome://extensions` → RedactVision → Popup)
2. Scroll to "Local personal profiles"
3. Fill in Name, Email, Phone, Address
4. Click "Save profile"
5. Profile is stored locally, radio selected automatically

### Step 2: Choose Profile for Task

1. If multiple profiles exist, click "Use for form" on the desired profile
2. Or click the radio button next to "Use this profile"
3. Profile is now the active selection for this browser session

### Step 3: Start Agent Task

1. Click the RedactVision launcher pill on any website
2. Enter task: "Fill this form with my details"
3. Agent perceives the page (locally, privacy firewall runs)
4. Agent sends sanitized context to server
5. Server LLM plans actions using tokenized values
6. Agent executes actions, resolving tokens from the selected profile

### Step 4: Observe Form Filling

- Watch the chat card show which fields are being filled
- The extension types original values into fields (resolved locally)
- Server never sees raw profile data

## Testing Locally

### Environment

**Terminal 1 — Test page:**

```bash
cd test-site
python3 -m http.server 8000
# Navigate to http://localhost:8000/
```

**Terminal 2 — Server:**

```bash
cd server
source ../.venv/bin/activate
python -m uvicorn redactvision_server.main:app --port 8001
```

**Chrome:**

1. Load unpacked extension from `extension/dist/`
2. Open http://localhost:8000/ in a tab
3. Click RedactVision launcher pill

### Test Scenario

1. **Save a test profile:**
   - Name: Shrijal Gupta
   - Email: shrijal@example.com
   - Phone: +91 9876543210

2. **Visit test form:**
   - http://localhost:8000/
   - It has name, email, phone, address fields

3. **Start agent task:**
   - Ask: "Fill this form with my details"
   - Watch:
     - Chat shows tokenized values ([PERSON_01], [EMAIL_01], etc.)
     - Privacy summary card shows what was detected
     - Form fields get filled with original values
     - Server never receives raw data

4. **Verify privacy:**
   - Open browser DevTools → Network tab
   - Check POST to `/llm/plan`
   - Inspect request body — should contain [PERSON_01], not "Shrijal Gupta"
   - Open browser DevTools → Application → Local Storage
   - Check `chrome-extension://...` storage
   - See profiles stored but not sent to network

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                     BROWSER TAB                                  │
│  ┌─────────────────────────────────────────────────────────────┐ │
│  │ Test Form (localhost:8000)                                  │ │
│  │  ├─ Name input                                              │ │
│  │  ├─ Email input                                             │ │
│  │  ├─ Phone input                                             │ │
│  │  └─ Address textarea                                        │ │
│  └─────────────────────────────────────────────────────────────┘ │
│                           ▲                                       │
│                           │ Type original values                  │
│  ┌─────────────────────────┼─────────────────────────────────┐   │
│  │ Extension Content Script│                                 │   │
│  │  ┌────────────────────────────────────────────────────┐   │   │
│  │  │ Privacy Firewall (privacy-firewall.ts)             │   │   │
│  │  │  - Detect sensitive values in page DOM             │   │   │
│  │  │  - Token map: {[PERSON_01]: "Shrijal Gupta", ...}  │   │   │
│  │  │  - Sanitized DOM: replace values with tokens       │   │   │
│  │  └────────────────────────────────────────────────────┘   │   │
│  │                         ▲                                  │   │
│  │                         │ Sanitized context only           │   │
│  │  ┌────────────────────────────────────────────────────┐   │   │
│  │  │ Agent Session (agent-session.ts)                   │   │   │
│  │  │  - Run perception + planning loop                  │   │   │
│  │  │  - Call Server LLM                                 │   │   │
│  │  │  - Execute actions locally                         │   │   │
│  │  └────────────────────────────────────────────────────┘   │   │
│  │                         ▲                                  │   │
│  │                         │ Tokenized actions                │   │
│  │  ┌────────────────────────────────────────────────────┐   │   │
│  │  │ Action Executor (action-executor.ts)               │   │   │
│  │  │  - Validate action                                 │   │   │
│  │  │  - Resolve [PROFILE:email] locally                 │   │   │
│  │  │    (from page-local map or selected profile)       │   │   │
│  │  │  - Execute: type original value                    │   │   │
│  │  └────────────────────────────────────────────────────┘   │   │
│  │                         ▲                                  │   │
│  └─────────────────────────┼──────────────────────────────────┘   │
│                            │                                      │
│  ┌─────────────────────────┼──────────────────────────────────┐   │
│  │ Browser Storage (chrome.storage.local)                      │   │
│  │  ├─ rv_local_profiles_v2: encrypted profile envelopes       │   │
│  │  ├─ IndexedDB: non-extractable AES-GCM vault key            │   │
│  │  ├─ rv_selected_profile_id: "profile-12345"                 │   │
│  │  └─ [NEVER SENT TO SERVER]                                 │   │
│  └──────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                            │
                            │ Sanitized context with
                            │ tokens only (NOT raw values)
                            ▼
             ╔════════════════════════════════════╗
             ║   NETWORK BOUNDARY / TRUST ZONE    ║
             ╚════════════════════════════════════╝
                            │
                            ▼
         ┌──────────────────────────────────────┐
         │  FastAPI Server (port 8001)          │
         │  POST /llm/plan                      │
         │   ├─ Receive sanitized context      │
         │   │  (e.g. [PERSON_01], [EMAIL_01])│
         │   ├─ Call Server LLM                │
         │   │  "Fill form with context..."    │
         │   ├─ LLM generates actions          │
         │   │  {action: type, value: ...}     │
         │   └─ Return action JSON             │
         └──────────────────────────────────────┘
                         │
                         │ Tokenized actions only
                         │ (still NO raw values)
                         ▼
            [Back to content script]
                [Resolve tokens locally]
                [Execute in browser]
```

## Current Implementation Status

### ✅ Implemented

- [x] Privacy firewall with DOM semantic detection + regex heuristics
- [x] Local token map generation and storage
- [x] Semantic token replacement in sanitized context
- [x] Local profile storage in `chrome.storage.local`
- [x] Profile CRUD operations (save, select, delete, load)
- [x] Action executor with local token resolution
- [x] Token resolution fallback: page-local map → selected profile
- [x] Server LLM planner receives sanitized context
- [x] Extension popup UI for profile management
- [x] Local AI status indicator (profile matcher + optional model package)
- [x] "Use for form" action to quickly select a profile

### 🔄 In Progress

- [ ] End-to-end test of form filling with selected profile (waiting for user task)
- [ ] Optional lightweight Hugging Face model for local recommendations
- [ ] Profile candidate matching from page context
- [ ] Automatic profile selection UI

### 📋 Planned

- [ ] Profile sync across devices (optional, Supabase integration)
- [ ] Keyboard shortcuts for quick profile selection
- [ ] Form field auto-mapping (detect field → suggest profile field)
- [ ] Action history and undo/redo

## Debugging Tips

### Verify Privacy Firewall

Open DevTools Console on any page with the extension:

```javascript
// In content script context (via extension console):
privacyFirewall.getLocalTokenMap();
// Should show: [{token: "[EMAIL_01]", type: "EMAIL", ...}, ...]
```

### Check Selected Profile

```javascript
// In any tab with the extension:
chrome.storage.local.get("rv_selected_profile_id", (result) => {
  console.log("Selected profile ID:", result.rv_selected_profile_id);
});
chrome.storage.local.get("rv_local_profiles_v2", (result) => {
  console.log("Encrypted profile envelopes:", result.rv_local_profiles_v2);
});
```

### Inspect Server Request

Open DevTools → Network tab and look for POST to `/llm/plan`:

- Request body should have `sanitized_context` with [PERSON_01], [EMAIL_01], etc.
- Should NOT contain raw values like "Shrijal Gupta"

### Trace Action Execution

In chat card, each action shows:

- ✓ Validation passed
- ✓ Token resolved from [source]
- ✓ Value typed into field
- ✓ Field updated

## API Reference

### PrivacyFirewall

```typescript
class PrivacyFirewall {
  // Detect & tokenize all sensitive values in page DOM
  sanitizePage(rawDOM: RawPageDOM): SanitizedPageDOM;

  // Get internal token map (never sent to server)
  getLocalTokenMap(): TokenEntry[];

  // Resolve token using page-local map only
  resolveToken(token: string): string | null;
}
```

### ProfileStore

```typescript
// Load all profiles from browser storage
async function loadLocalProfiles(): Promise<LocalProfileEntry[]>;

// Save profiles to browser storage
async function saveLocalProfiles(profiles: LocalProfileEntry[]): Promise<void>;

// Get currently selected profile ID
async function getSelectedProfileId(): Promise<string | null>;

// Set selected profile
async function setSelectedProfileId(profileId: string | null): Promise<void>;

// Get selected profile object
async function getSelectedProfile(): Promise<LocalProfileEntry | null>;

// Add or update a profile
async function upsertLocalProfile(profile: LocalProfileEntry): Promise<void>;

// Remove a profile
async function removeLocalProfile(profileId: string): Promise<void>;

// Build token map from a profile
function buildProfileTokenMap(
  profile: LocalProfileEntry | null,
): Record<string, string>;

// Resolve token from selected profile
async function resolveTokenFromProfile(token: string): Promise<string | null>;
```

### ActionExecutor

```typescript
class ActionExecutor {
  // Validate action against current page
  validate(action: PlannedAction): { valid: boolean; reason?: string };

  // Execute action with local token resolution
  async execute(action: PlannedAction): Promise<ActionResult>;
}
```

## Common Issues & Solutions

### Issue: "Token not in local map"

**Cause:** Token was not found in page-local privacy map AND no selected profile set.

**Solution:**

1. Verify a profile is selected (popup → Local personal profiles → radio button checked)
2. Verify the profile has the required field (e.g., email for `[PROFILE:email]`)
3. Check encrypted profile storage: `chrome.storage.local.get("rv_local_profiles_v2")`

### Issue: Form not filling with correct values

**Cause:** Wrong profile selected or field not detected.

**Solution:**

1. Click "Use for form" button on the correct profile in popup
2. Refresh the page
3. Start a fresh agent task

### Issue: Server not receiving sanitized context

**Cause:** Privacy firewall not enabled or not detecting sensitive values.

**Solution:**

1. Check popup: "Auto-redact sensitive data" toggle must be ON
2. Verify page DOM has detectable sensitive fields (name, email inputs)
3. Open DevTools Console and check: `privacyFirewall.getLocalTokenMap()`

---

**Last Updated:** 2026-08-31
**Version:** v0.2.0 - Form Filling with Local Profiles
