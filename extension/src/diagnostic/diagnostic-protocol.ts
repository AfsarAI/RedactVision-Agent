/**
 * RedactVision Agent — Diagnostic and Auto-Recovery Protocol
 *
 * Implements a 4-phase diagnostic workflow and self-healing system:
 *   Phase 1: Context Invalidation Diagnostics & Guards
 *   Phase 2: Message Channel Retry & Exponential Backoff
 *   Phase 3: Network Response & Fetch Safety Validation
 *   Phase 4: Agent Autonomous Self-Healing, State Snapshots & Recovery Banner
 */

const RECOVERY_BANNER_ID = "rv-context-recovery-banner";
const TASK_SNAPSHOT_KEY = "rv_preserved_task_snapshot";

// ===================================================================
// Phase 1: Context Invalidation Diagnostics
// ===================================================================

/**
 * Verifies if the extension runtime execution context is still valid.
 */
export function isExtensionContextValid(): boolean {
  try {
    return typeof chrome !== "undefined" && !!(chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

/**
 * Diagnostic Middleware Check:
 * Wraps tasks with context guardrails, triggering recovery warnings instead of crashing.
 */
export function executeWithContextGuard<T>(
  taskFunction: () => T,
  fallbackValue?: T
): T | undefined {
  if (!isExtensionContextValid()) {
    console.warn(
      "[DiagnosticEngine] Extension context invalidated. Triggering graceful fallback / self-reload warning."
    );
    notifyContextInvalidated();
    return fallbackValue;
  }
  try {
    return taskFunction();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (isContextInvalidatedError(msg)) {
      notifyContextInvalidated();
      return fallbackValue;
    }
    throw err;
  }
}

export function isContextInvalidatedError(message: string): boolean {
  return (
    message.includes("Extension context invalidated") ||
    message.includes("context invalidated") ||
    message.includes("message port closed") ||
    message.includes("could not establish connection") ||
    message.includes("Receiving end does not exist")
  );
}

// ===================================================================
// Phase 2: Message Channel & Connection Diagnostics
// ===================================================================

/**
 * Safely sends a message from content script to background service worker
 * with exponential backoff retry and explicit chrome.runtime.lastError interception.
 */
export async function safeSendMessage<T = unknown>(
  message: Record<string, unknown>,
  retries = 3
): Promise<T> {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      if (!isExtensionContextValid()) {
        notifyContextInvalidated();
        throw new Error("[DiagnosticEngine] Extension context invalidated");
      }

      return await new Promise<T>((resolve, reject) => {
        chrome.runtime.sendMessage(message, (response) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }
          resolve(response as T);
        });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isContextInvalidatedError(msg)) {
        notifyContextInvalidated();
        throw err;
      }

      console.warn(
        `[DiagnosticEngine] Message delivery attempt ${attempt}/${retries} failed: ${msg}`
      );

      if (attempt === retries) throw err;

      // Exponential backoff: 200ms, 400ms, 800ms...
      const delayMs = Math.pow(2, attempt) * 100;
      await new Promise((res) => setTimeout(res, delayMs));
    }
  }

  throw new Error("[DiagnosticEngine] Max message delivery retries exceeded");
}

// ===================================================================
// Phase 3: Network Response & Fetch Safety Diagnostics
// ===================================================================

/**
 * Safe fetch wrapper that prevents 'reading ok of undefined' errors
 * and guarantees structured API error messages.
 */
export async function safeAgentFetch<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  let response: Response;

  try {
    response = await fetch(url, options);
  } catch (networkError) {
    const msg = networkError instanceof Error ? networkError.message : String(networkError);
    throw new Error(`[NetworkFailure] Server unreachable or CORS blocked: ${msg}`);
  }

  if (!response) {
    throw new Error("[NetworkFailure] Fetch returned an undefined response object.");
  }

  if (!response.ok) {
    let errorBody = "";
    try {
      errorBody = await response.text();
    } catch {
      errorBody = "Unable to read error body";
    }
    throw new Error(
      `[APIError] Status ${response.status} - ${response.statusText}: ${errorBody}`
    );
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("[ParseFailure] Server returned invalid non-JSON response");
  }
}

// ===================================================================
// Phase 4: Agent Autonomous Self-Healing Loop
// ===================================================================

export interface TaskSnapshot {
  prompt: string;
  url: string;
  timestamp: number;
  history?: unknown[];
}

/**
 * State Snapshot Preservation:
 * Serializes current task state into sessionStorage before fatal exceptions
 * so user progress can be resumed upon refresh.
 */
export function saveTaskSnapshot(snapshot: TaskSnapshot): void {
  try {
    sessionStorage.setItem(TASK_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    /* ignore storage quota limits */
  }
}

/**
 * Load and restore a preserved task snapshot.
 */
export function restoreTaskSnapshot(): TaskSnapshot | null {
  try {
    const raw = sessionStorage.getItem(TASK_SNAPSHOT_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(TASK_SNAPSHOT_KEY); // single-use
    const parsed = JSON.parse(raw) as TaskSnapshot;
    // Discard snapshots older than 10 minutes
    if (Date.now() - parsed.timestamp > 10 * 60 * 1000) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearTaskSnapshot(): void {
  try {
    sessionStorage.removeItem(TASK_SNAPSHOT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Context Recovery Notification:
 * Injects a floating banner into the host page notifying the user to refresh.
 */
export function showContextRecoveryBanner(customMessage?: string): void {
  if (document.getElementById(RECOVERY_BANNER_ID)) return;

  const banner = document.createElement("div");
  banner.id = RECOVERY_BANNER_ID;
  banner.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 2147483647;
    background: #0f172a;
    color: #f8fafc;
    border: 1px solid rgba(91, 107, 255, 0.45);
    border-radius: 12px;
    padding: 10px 16px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 13px;
    font-weight: 500;
    display: flex;
    align-items: center;
    gap: 12px;
    box-shadow: 0 10px 30px rgba(0, 0, 0, 0.45), 0 0 12px rgba(91, 107, 255, 0.35);
    animation: rv-banner-drop 0.25s ease-out;
  `;

  const messageText =
    customMessage ||
    "RedactVision Agent was reloaded. Refresh this tab to resume automation.";

  banner.innerHTML = `
    <span style="font-size: 16px;">⚡</span>
    <span>${escapeHtml(messageText)}</span>
    <button id="rv-recovery-refresh-btn" style="
      background: linear-gradient(135deg, #5b6bff, #4554e6);
      color: white;
      border: none;
      padding: 5px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    ">🔄 Refresh Tab</button>
    <button id="rv-recovery-close-btn" style="
      background: transparent;
      color: #94a3b8;
      border: none;
      cursor: pointer;
      font-size: 16px;
      line-height: 1;
      padding: 2px 4px;
    ">×</button>
  `;

  document.body.appendChild(banner);

  const refreshBtn = banner.querySelector("#rv-recovery-refresh-btn");
  refreshBtn?.addEventListener("click", () => {
    window.location.reload();
  });

  const closeBtn = banner.querySelector("#rv-recovery-close-btn");
  closeBtn?.addEventListener("click", () => {
    banner.remove();
  });
}

function notifyContextInvalidated(): void {
  window.dispatchEvent(new CustomEvent("AGENT_CONTEXT_INVALIDATED"));
  showContextRecoveryBanner();
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
