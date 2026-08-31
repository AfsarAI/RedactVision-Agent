/**
 * RedactVision Agent - Content script
 *
 * Responsibilities:
 *  - Capture DOM locally (never sent to server)
 *  - Run the local privacy firewall + tokenization
 *  - Inject a floating launcher pill at the bottom-right of every page
 *  - On launcher click, open a 380×580 floating chat card anchored above
 *    the launcher (draggable, minimizable, closeable)
 *  - Owns the AgentSession that drives the in-page chat
 *  - Persists the card's drag offset per-hostname to chrome.storage.local
 *  - Replies to chrome.runtime messages from the popup with safe summaries
 *
 * Card styles are loaded from the bundled chat-ui.css via
 * `chrome.runtime.getURL()` so we don't ship a hand-duplicated copy.
 */

import { extractPageDOM } from "./dom-extractor";
import { PrivacyFirewall } from "../privacy/privacy-firewall";
import { AgentSession } from "../agent/agent-session";
import {
  buildChatUI,
  ChatUIHandles,
  RedactionSummary,
  ValidationError,
  rvLogoUrl,
  upgradeLogoUrl,
} from "../ui/chat-ui";
import {
  loadPlannerConfig,
  savePlannerConfig,
  PlannerConfig,
} from "../llm/llm-planner";

console.log("[RedactVision] Content script initialized");

/* ============================================================
 *  Client-side form validation
 *  Validates user input BEFORE calling LLM to prevent fake
 *  "server offline" errors when the real issue is invalid input.
 * ============================================================ */

interface ValidationResult {
  valid: boolean;
  error?: ValidationError;
}

function validateUserInput(prompt: string): ValidationResult {
  const lower = prompt.toLowerCase();

  // Email validation
  if (lower.includes("email") || lower.includes("e-mail")) {
    const emailFields = document.querySelectorAll<HTMLInputElement>(
      'input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]'
    );

    for (const field of emailFields) {
      const value = field.value.trim();
      if (value) {
        // Email regex pattern
        const emailPattern = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z]{2,}$/i;
        if (!emailPattern.test(value)) {
          return {
            valid: false,
            error: {
              field: "Email field",
              userValue: value,
              issue: `"${value}" is not a valid email format`,
              expected: "Valid email format (e.g., user@example.com)"
            }
          };
        }
      }
    }
  }

  // Password validation
  if (lower.includes("password") || lower.includes("pass")) {
    const passwordFields = document.querySelectorAll<HTMLInputElement>(
      'input[type="password"]'
    );

    for (const field of passwordFields) {
      const value = field.value;
      if (value && value.length < 6) {
        return {
          valid: false,
          error: {
            field: "Password field",
            userValue: `${value.length} characters`,
            issue: "Password is too short",
            expected: "At least 6 characters"
          }
        };
      }
    }
  }

  // Phone validation
  if (lower.includes("phone") || lower.includes("mobile") || lower.includes("tel")) {
    const phoneFields = document.querySelectorAll<HTMLInputElement>(
      'input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[name*="mobile" i]'
    );

    for (const field of phoneFields) {
      const value = field.value.trim();
      if (value) {
        // Extract digits only
        const digits = value.replace(/\D/g, "");
        if (digits.length < 10 || digits.length > 15) {
          return {
            valid: false,
            error: {
              field: "Phone field",
              userValue: value,
              issue: `Phone number has ${digits.length} digits`,
              expected: "10-15 digits (e.g., 1234567890)"
            }
          };
        }
      }
    }
  }

  // All validations passed
  return { valid: true };
}

/* ============================================================
 *  Dashboard settings (shared with the popup via chrome.storage)
 *  - active          master switch — launcher is not injected when off
 *  - showWidget      launcher pill visibility
 *  - autoRedact      privacy firewall on/off
 *  - theme           dark | light | auto (applied to the chat card)
 *  - domainWhitelist when non-empty, the agent only runs on these hosts
 * ============================================================ */

interface DashboardSettings {
  active: boolean;
  showWidget: boolean;
  autoRedact: boolean;
  theme: "dark" | "light" | "auto";
  domainWhitelist: string[];
}

const DASHBOARD_KEY = "rv_dashboard_settings";

/** Persist a single dashboard setting (used by in-card quick settings). */
async function saveDashboardSetting<K extends keyof DashboardSettings>(
  key: K,
  value: DashboardSettings[K]
): Promise<void> {
  try {
    const s = await loadDashboardSettings();
    s[key] = value;
    await chrome.storage.local.set({ [DASHBOARD_KEY]: s });
  } catch {
    /* ignore */
  }
}

async function loadDashboardSettings(): Promise<DashboardSettings> {
  const defaults: DashboardSettings = {
    active: true,
    showWidget: true,
    autoRedact: true,
    theme: "dark",
    domainWhitelist: [],
  };
  try {
    const stored = await chrome.storage.local.get(DASHBOARD_KEY);
    const s = stored?.[DASHBOARD_KEY] as Partial<DashboardSettings> | undefined;
    if (!s) return defaults;
    return {
      active: s.active !== false,
      showWidget: s.showWidget !== false,
      autoRedact: s.autoRedact !== false,
      theme: s.theme === "light" || s.theme === "auto" ? s.theme : "dark",
      domainWhitelist: Array.isArray(s.domainWhitelist)
        ? s.domainWhitelist.filter((d): d is string => typeof d === "string")
        : [],
    };
  } catch {
    return defaults;
  }
}

/* ============================================================
 *  Local perception + privacy firewall (run once on page load)
 *  - rawPageDOM is NEVER sent to the server.
 *  - sanitizedPageDOM is the only thing that can leave the device.
 * ============================================================ */

const privacyFirewall = new PrivacyFirewall();
const sanitizedPageDOM = privacyFirewall.sanitizePage(extractPageDOM());

console.log("[RedactVision] Page perception completed");
console.log("[RedactVision] Privacy scan completed");
const summary = privacyFirewall.getLocalTokenMap();
console.log(`[RedactVision] Sensitive regions detected: ${summary.length}`);
console.log("[RedactVision] Context sanitized");
console.log("[RedactVision] Sending sanitized context to agent");
console.log("[RedactVision] Agent reasoning via server LLM");

/* ============================================================
 *  Background unified pipeline
 *  ----------------------------------------------------------------
 *  An earlier prototype used to spin up `runUnifiedPipeline()` here
 *  on a 1-second timer to demonstrate the privacy flow. That demo:
 *    - was unrelated to the chat agent,
 *    - spammed the console with a hardcoded "click #submit" run,
 *    - was the second competing pipeline called out in the
 *      architecture correction.
 *  The chat agent runs its own perception + privacy pipeline
 *  inside `runPrompt()`; no second pipeline is started here.
 * ============================================================ */


/* ============================================================
 *  Stylesheet injection
 *  - Fetch the shared chat-ui.css from the extension at runtime so
 *    we don't ship a hand-duplicated 270-line CSS blob.
 *  - On failure (e.g. file:// URLs), fall back to a minimal inline
 *    style so the card is at least usable.
 * ============================================================ */

const STYLE_TAG_ID = "rv-chat-styles";
const STYLE_FALLBACK = `
  .rv-chat { position:fixed;bottom:84px;right:20px;width:380px;height:580px;
    background:#131a30;color:#e6ecff;border:1px solid #2a3155;border-radius:16px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","SF Pro Text",Inter,Roboto,sans-serif;
    font-size:13px;z-index:2147483646;display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 20px 25px -5px rgba(0,0,0,.5),0 8px 10px -6px rgba(0,0,0,.4);
  }
  .rv-chat-header{display:flex;align-items:center;gap:10px;padding:12px 14px 11px;border-bottom:1px solid #2a3155;flex-shrink:0;cursor:grab;user-select:none}
  .rv-chat-brand{display:flex;align-items:center;gap:9px;flex:1;min-width:0}
  .rv-chat-avatar{width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;letter-spacing:.5px;color:#fff;background:linear-gradient(135deg,#5b6bff,#22d3a0);border-radius:8px;box-shadow:0 2px 8px rgba(91,107,255,.4);flex-shrink:0;overflow:hidden}
  .rv-chat-avatar img,.rv-statusbar-avatar img{width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;user-select:none;pointer-events:none;-webkit-user-drag:none}
  .rv-chat-title{font-size:12.5px;font-weight:600;color:#e6ecff;letter-spacing:-.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .rv-chat-status-row{display:flex;align-items:center;gap:5px;font-size:10.5px;color:#94a3b8;margin-top:1px}
  .rv-chat-dot{width:6px;height:6px;border-radius:50%;display:inline-block;flex-shrink:0}
  .rv-chat-dot.rv-ready{background:#22d3a0;box-shadow:0 0 6px rgba(34,211,160,.7)}
  .rv-backend-pill{display:inline-flex;align-items:center;gap:5px;padding:3px 8px;font-size:10px;font-weight:600;border-radius:999px;background:rgba(91,107,255,.18);color:#e6ecff;border:1px solid rgba(91,107,255,.18);letter-spacing:.2px;flex-shrink:0}
  .rv-backend-pill .rv-backend-dot{width:5px;height:5px;border-radius:50%;background:#e6ecff}
  .rv-chat-controls{display:flex;gap:4px;flex-shrink:0}
  .rv-icon-btn{width:24px;height:24px;display:flex;align-items:center;justify-content:center;background:0 0;border:1px solid transparent;border-radius:6px;color:#94a3b8;font-size:14px;line-height:1;cursor:pointer}
  .rv-conversation{flex:1;overflow-y:auto;padding:14px 14px 8px;display:flex;flex-direction:column;gap:8px;scroll-behavior:smooth;min-height:0}
  .rv-msg{display:flex;align-items:flex-start;gap:8px;padding:8px 10px;border-radius:10px;font-size:12.5px;line-height:1.5}
  .rv-msg.rv-user{align-self:flex-end;max-width:85%;background:linear-gradient(135deg,rgba(91,107,255,.30),rgba(91,107,255,.18));border:1px solid rgba(91,107,255,.45);padding:7px 12px;border-radius:14px 14px 4px 14px}
  .rv-msg-body{flex:1;min-width:0;color:#e6ecff}
  .rv-composer{display:flex;align-items:flex-end;gap:8px;padding:10px 12px 12px;border-top:1px solid rgba(91,107,255,.18);background:rgba(7,11,24,.55);flex-shrink:0}
  .rv-input{flex:1;resize:none;background:rgba(15,23,42,.65);color:#e6ecff;border:1px solid rgba(91,107,255,.18);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:13px;line-height:1.4;max-height:100px;outline:none}
  .rv-send-btn{width:36px;height:36px;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,#5b6bff,#4554e6);color:#fff;border:none;border-radius:10px;cursor:pointer;font-size:14px;flex-shrink:0;box-shadow:0 2px 8px rgba(91,107,255,.30)}
  .rv-privacy-bar{height:2px;width:100%;background:linear-gradient(90deg,rgba(91,107,255,.4),rgba(34,211,160,.4),rgba(91,107,255,.4));background-size:200% 100%;flex-shrink:0}
`;

async function injectChatStyles(): Promise<void> {
  if (document.getElementById(STYLE_TAG_ID)) return;
  let css: string | null = null;
  // Only attempt to fetch from the extension if the context is still
  // valid (a stale content script — e.g. after extension reload — will
  // throw "Extension context invalidated" the moment we touch
  // chrome.runtime.getURL).
  const ctxValid = (() => {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  })();
  if (ctxValid) {
    try {
      const cssUrl = chrome.runtime.getURL("dist/ui/chat-ui.css");
      const resp = await fetch(cssUrl);
      if (resp.ok) css = await resp.text();
    } catch (e) {
      console.warn(
        "[RedactVision] Could not load chat-ui.css from extension bundle, using fallback styles:",
        e instanceof Error ? e.message : e
      );
    }
  }
  if (!css) css = STYLE_FALLBACK;
  const style = document.createElement("style");
  style.id = STYLE_TAG_ID;
  style.setAttribute("data-rv-chat-styles", "true");
  style.textContent = css;
  document.head.appendChild(style);
}

/* ============================================================
 *  In-page chat panel
 *  - Renders the floating chatbot card (no chrome-extension:// iframe).
 *  - Owns its own AgentSession that persists across prompts.
 *  - Position offset is restored from chrome.storage.local on open and
 *    saved on drag-end.
 * ============================================================ */

type PanelHandle = {
  root: HTMLElement;
  overlay: HTMLElement;
  ui: ChatUIHandles;
  session: AgentSession;
  sessionSignal: { cancelled: boolean };
};

let panel: PanelHandle | null = null;

const HOSTNAME = (() => {
  try {
    return window.location.hostname || "unknown";
  } catch {
    return "unknown";
  }
})();

const OFFSET_KEY = `rv_widget_offset_${HOSTNAME}`;

function getStoredOffset(): Promise<{ dx: number; dy: number }> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(OFFSET_KEY, (data: Record<string, unknown>) => {
        try {
          const o = data?.[OFFSET_KEY] as { dx?: number; dy?: number } | undefined;
          if (o && typeof o.dx === "number" && typeof o.dy === "number") {
            resolve({ dx: o.dx, dy: o.dy });
          } else {
            resolve({ dx: 0, dy: 0 });
          }
        } catch (err) {
          console.error("[RedactVision] Content: Error reading stored offset:", err);
          resolve({ dx: 0, dy: 0 });
        }
      });
    } catch (err) {
      console.error("[RedactVision] Content: Failed to get stored offset:", err);
      resolve({ dx: 0, dy: 0 });
    }
  });
}

function setStoredOffset(offset: { dx: number; dy: number }): void {
  try {
    chrome.storage.local.set({ [OFFSET_KEY]: offset });
  } catch {
    /* ignore */
  }
}

/* Launcher pill position — persisted per-hostname under its own key so
 * it can never collide with the chat card's drag offset (OFFSET_KEY).
 * Stored as absolute left/top viewport px (null = never dragged). */
const LAUNCHER_POS_KEY = `rv_launcher_pos_${HOSTNAME}`;

function getLauncherPos(): Promise<{ x: number | null; y: number | null }> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(LAUNCHER_POS_KEY, (data: Record<string, unknown>) => {
        try {
          const o = data?.[LAUNCHER_POS_KEY] as { x?: unknown; y?: unknown } | undefined;
          if (
            o &&
            typeof o.x === "number" &&
            typeof o.y === "number" &&
            Number.isFinite(o.x) &&
            Number.isFinite(o.y)
          ) {
            resolve({ x: o.x, y: o.y });
          } else {
            resolve({ x: null, y: null });
          }
        } catch (err) {
          console.error("[RedactVision] Content: Error reading launcher position:", err);
          resolve({ x: null, y: null });
        }
      });
    } catch (err) {
      console.error("[RedactVision] Content: Failed to get launcher position:", err);
      resolve({ x: null, y: null });
    }
  });
}

function setLauncherPos(x: number, y: number): void {
  try {
    chrome.storage.local.set({ [LAUNCHER_POS_KEY]: { x, y } });
  } catch {
    /* ignore */
  }
}

/** Morph state machine — one source of truth for the launcher/panel pair.
 *  closed → opening → open → closing → closed. "opening"/"closing"
 *  swallow rapid clicks so the UI can never end up with two panels, a
 *  hidden launcher, or a stuck intermediate state. */
type MorphState = "closed" | "opening" | "open" | "closing";
let morphState: MorphState = "closed";

function getLauncherEl(): HTMLElement | null {
  return document.getElementById("rv-agent-indicator");
}

/**
 * Open the chat panel by MORPHING it out of the floating launcher.
 *
 * - The panel element (and its AgentSession) is created ONCE and kept
 *   alive across minimize/restore, so conversation, activity feed and
 *   sanitized data survive the morph. Only a full close (×) destroys it.
 * - The panel is anchored to the launcher's exact on-screen position
 *   (smart quadrant: expands toward the side with the most space).
 */
async function openInPagePanel(): Promise<void> {
  if (morphState !== "closed") return;
  morphState = "opening";

  const launcher = getLauncherEl();
  // 0–160ms: press feedback on the launcher (grow + glow) before the morph.
  if (launcher) {
    launcher.classList.add("rv-press");
    setTimeout(() => launcher.classList.remove("rv-press"), 180);
  }

  try {
    if (!panel) {
      await injectChatStyles();
      await buildPanel();
      if (!panel) {
        morphState = "closed";
        return;
      }
    }
    // Show the panel (it is display:none after a morph-close).
    const root = panel.root as HTMLElement;
    root.style.display = "flex";
    playOpenMorph();
  } catch (err) {
    console.error("[RedactVision] Content: Failed to open panel:", err);
    morphState = "closed";
  }
}

async function buildPanel(): Promise<void> {
  // The overlay is just a positioning wrapper. The chat card inside
  // it is what the user sees and drags. We make the overlay cover the
  // page so we can layer the card on top of it (the card has
  // `position: fixed` already, so technically the overlay could be
  // omitted — but it gives us a stable container for cleanup).
  const overlay = document.createElement("div");
  overlay.id = "rv-inpage-overlay";
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    z-index: 2147483645;
    pointer-events: none;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  `;
  document.body.appendChild(overlay);

  const ui = buildChatUI(overlay);

  // Load planner config.
  const config: PlannerConfig = await loadPlannerConfig();

  const session = new AgentSession(
    {
      onActivity: (activity) => ui.appendActivity(activity),
      onPlanResult: (result) => {
        // The planner is the server LLM. If it didn't return a label,
        // show a generic "Server" pill so the user knows the action
        // path. When the planner is offline, the label will already
        // say "Server (offline)" from the planner itself.
        const label = result.backendLabel || (result.source === "server-llm" ? "Server" : "—");
        ui.setBackend(label);
      },
    },
    config
  );

  // Apply the popup's dashboard settings to this session.
  const dash = await loadDashboardSettings();
  session.setAutoRedact(dash.autoRedact);
  ui.applyTheme(dash.theme);
  ui.setAutoRedactState(dash.autoRedact);

  // In-card quick settings (footer ⚙ / 🌙 buttons) persist to storage.
  ui.onThemeToggle(async (next) => {
    ui.applyTheme(next);
    await saveDashboardSetting("theme", next);
  });
  ui.onAutoRedactChange(async (enabled) => {
    session.setAutoRedact(enabled);
    await saveDashboardSetting("autoRedact", enabled);
  });

  const sessionSignal = { cancelled: false };

  // Render the initial redaction summary using whatever the privacy
  // firewall found on the first page scan.
  const initialSummary: RedactionSummary = session.getRedactionSummary(false);
  ui.setRedactionSummary(initialSummary);

  ui.setStatus("ready", "Ready");
  ui.clearConversation();
  ui.setBackend("Server"); // replaced with the active LLM provider on first plan

  ui.onSend(async (text) => {
    ui.setInputValue("");
    ui.setInputEnabled(false);

    // CLIENT-SIDE VALIDATION — check form inputs BEFORE calling LLM
    const validation = validateUserInput(text);
    if (!validation.valid && validation.error) {
      // Show validation error card instead of calling LLM
      ui.showValidationError(validation.error);
      ui.setStatus("error", "Invalid input");
      ui.setInputEnabled(true);
      return;
    }

    ui.setStatus("thinking", "Working…");
    try {
      const outcome = await session.runPrompt(text);
      const finalPhase = outcome.phase;
      const isCompleted = finalPhase === "completed";
      const isFailed = finalPhase === "failed" || finalPhase === "max_iterations_reached" || finalPhase === "cancelled";
      const isOffline = finalPhase === "offline";
      const uiPhase = isCompleted ? "completed" : (isFailed || isOffline) ? "error" : "thinking";
      const isContextInvalidatedOutcome = outcome.reason.includes(
        "Extension context invalidated"
      );

      if (isContextInvalidatedOutcome) {
        // ONE clear message with a working refresh button. We deliberately
        // skip the generic end-of-task summary card here — showing both a
        // "Task could not be completed" summary AND this error would stack
        // two conflicting messages for the same failure.
        ui.setRedactionSummary(session.getRedactionSummary(false));
        ui.setSanitizedData(session.getSanitizedData());
        ui.showSystemError({
          type: "extension_context_invalidated",
          title: "Please refresh this page",
          message:
            "The extension was updated or reloaded. This page is still connected to the previous version — refresh (F5 / Cmd+R) to reconnect.",
          actionLabel: "🔄 Refresh Page",
          actionType: "refresh",
        });
        ui.setStatus("error", "Refresh needed");
      } else {
      // After the prompt, re-summarize (page state may have changed).
      ui.setRedactionSummary(session.getRedactionSummary(false));
      // Refresh the sanitized-data snapshot for the details panel.
      ui.setSanitizedData(session.getSanitizedData());
      // Render the polished end-of-task summary card.
      const summaryPhase = isCompleted
        ? "completed"
        : isOffline
        ? "offline"
        : isFailed
        ? finalPhase === "cancelled"
          ? "cancelled"
          : finalPhase === "max_iterations_reached"
          ? "max_iterations_reached"
          : "failed"
        : "completed";
      ui.showSummary({
        phase: summaryPhase as "completed" | "failed" | "max_iterations_reached" | "cancelled" | "offline",
        message: isCompleted
          ? "Task completed successfully"
          : isOffline
          ? "Server agent offline"
          : isFailed
          ? finalPhase === "cancelled"
            ? "Cancelled by user"
            : finalPhase === "max_iterations_reached"
            ? "Agent could not confirm completion within the safety limit"
            : "Task could not be completed"
          : "Stopped",
        reason: outcome.reason,
        iterations: outcome.iterations,
        actionsPlanned: outcome.actionsPlanned,
        actionsExecuted: outcome.actionsExecuted,
        durationMs: outcome.durationMs,
        privacy: session.getRedactionSummary(false),
      });
      ui.setStatus(
        uiPhase,
        isCompleted
          ? "Completed"
          : isOffline
          ? "Server offline"
          : isFailed
          ? finalPhase === "cancelled"
            ? "Cancelled"
            : finalPhase === "max_iterations_reached"
            ? "Stopped"
            : "Failed"
          : "Working…"
      );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const isContextInvalidated =
        message.includes("Extension context invalidated") ||
        message.includes("context invalidated") ||
        (err instanceof DOMException && err.name === "InvalidStateError");

      if (isContextInvalidated) {
        ui.showSystemError({
          type: "extension_context_invalidated",
          title: "Please refresh this page",
          message:
            "The extension was updated or reloaded. This page is still connected to the previous version — refresh (F5 / Cmd+R) to reconnect.",
          actionLabel: "🔄 Refresh Page",
          actionType: "refresh",
        });
        ui.setStatus("error", "Refresh needed");
      } else {
        ui.showSystemError({
          type: "runtime_error",
          title: "Something went wrong",
          message: `Error: ${message}. Please try again, or refresh the page if the problem persists.`,
          actionLabel: "🔄 Retry",
          actionType: "retry",
        });
        ui.setStatus("error", "Error");
      }
      console.error("[ContentScript] Agent error:", err);
    } finally {
      sessionSignal.cancelled = false;
      ui.setInputEnabled(true);
    }
  });

  ui.onCancel(() => {
    sessionSignal.cancelled = true;
    session.cancel();
  });

  ui.onMinimize(() => {
    // "-" triggers the REVERSE morph: panel collapses into the launcher.
    morphClose();
  });

  ui.onClose(() => {
    destroyPanel();
  });

  ui.onDragEnd((off) => {
    setStoredOffset(off);
  });

  panel = { root: overlay.firstElementChild as HTMLElement, overlay, ui, session, sessionSignal };
  (ui.root as HTMLElement).style.pointerEvents = "auto";
  // Re-attach pointer-events to the launcher too (it's a sibling).
  const launcher = document.getElementById("rv-agent-indicator");
  if (launcher) (launcher as HTMLElement).style.pointerEvents = "auto";

  ui.focusInput();
}

/**
 * Animate the panel growing OUT of the launcher's exact position.
 * The panel is positioned so its corner nearest the launcher stays
 * fixed (transform-origin), then scales 0.09 → 1 with a spring easing
 * while the launcher fades/scales away in parallel — the two read as
 * ONE object transforming.
 */
function playOpenMorph(): void {
  if (!panel) return;
  const root = panel.root as HTMLElement;
  const launcher = getLauncherEl();

  const anchor = computeMorphAnchor(root, launcher);
  panel.ui.setDragOffset(anchor.x, anchor.y);
  root.style.transformOrigin = anchor.origin;

  root.classList.add("rv-morph", "rv-morph-start");
  // Flush styles so the start state is committed before transitioning.
  void root.offsetWidth;
  requestAnimationFrame(() => {
    root.classList.remove("rv-morph-start");
    if (launcher) launcher.classList.add("rv-hidden");
    finishOnTransition(root, () => {
      root.classList.remove("rv-morph");
      root.style.transformOrigin = "";
      morphState = "open";
    });
    panel?.ui.focusInput();
  });
}

/** Panel left/top + transform-origin derived from the launcher position.
 *  Launcher bottom-right → panel expands up/left; bottom-left → up/right;
 *  top-right → down/left; top-left → down/right. Always viewport-clamped. */
function computeMorphAnchor(
  root: HTMLElement,
  launcher: HTMLElement | null
): { x: number; y: number; origin: string } {
  const w = root.offsetWidth || 380;
  const h = root.offsetHeight || 580;
  const margin = 8;
  const rect = launcher?.getBoundingClientRect();
  const cx = rect ? rect.left + rect.width / 2 : window.innerWidth - 48;
  const cy = rect ? rect.top + rect.height / 2 : window.innerHeight - 48;

  const expandLeft = cx > window.innerWidth / 2;
  const expandUp = cy > window.innerHeight / 2;
  let x = expandLeft ? cx - w : cx;
  let y = expandUp ? cy - h : cy;
  x = Math.min(Math.max(margin, x), Math.max(margin, window.innerWidth - w - margin));
  y = Math.min(Math.max(margin, y), Math.max(margin, window.innerHeight - h - margin));
  // Origin = the panel corner that sits at the launcher.
  const origin = `${expandLeft ? "100%" : "0%"} ${expandUp ? "100%" : "0%"}`;
  return { x, y, origin };
}

/** Resolve when the morph transition actually ends (timeout fallback so
 *  a missed transitionend can never strand the state machine). */
function finishOnTransition(el: HTMLElement, done: () => void): void {
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    el.removeEventListener("transitionend", onEnd);
    done();
  };
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === el && e.propertyName === "transform") finish();
  };
  el.addEventListener("transitionend", onEnd);
  setTimeout(finish, 600);
}

/**
 * Minimize ("-"): collapse the panel back INTO the floating launcher.
 * The panel is hidden (NOT destroyed) — session, conversation, activity
 * feed and sanitized data all survive. The launcher reappears at exactly
 * the position it had before opening (its left/top is never touched).
 */
function morphClose(): void {
  if (morphState !== "open" || !panel) return;
  morphState = "closing";
  const root = panel.root as HTMLElement;
  const launcher = getLauncherEl();

  // Origin = panel corner nearest the launcher so the shrink lands on it.
  const r = root.getBoundingClientRect();
  const lr = launcher?.getBoundingClientRect();
  const cx = lr ? lr.left + lr.width / 2 : r.left + r.width / 2;
  const cy = lr ? lr.top + lr.height / 2 : r.top + r.height / 2;
  root.style.transformOrigin = `${cx > r.left + r.width / 2 ? "100%" : "0%"} ${
    cy > r.top + r.height / 2 ? "100%" : "0%"
  }`;

  // Sequence matters: commit the full-size state with the transition
  // enabled FIRST, then add the start (pill-sized) state — otherwise
  // both land in the same style flush and the shrink never animates.
  root.classList.add("rv-morph");
  void root.offsetWidth; // flush
  root.classList.add("rv-morph-start");
  // The launcher reappears near the END of the shrink so the two read
  // as one object handing over, not two separate elements.
  setTimeout(() => launcher?.classList.remove("rv-hidden"), 300);
  finishOnTransition(root, () => {
    root.style.display = "none";
    root.classList.remove("rv-morph", "rv-morph-start");
    root.style.transformOrigin = "";
    launcher?.classList.remove("rv-hidden");
    morphState = "closed";
  });
}

/** Fully tear down the panel + session (× button, settings off, teardown). */
function destroyPanel(): void {
  if (panel) {
    panel.session.cancel();
    panel.overlay.remove();
    panel = null;
  }
  morphState = "closed";
  getLauncherEl()?.classList.remove("rv-hidden", "rv-press");
}

function closeInPagePanel(): void {
  destroyPanel();
}

/* ============================================================
 *  Floating launcher pill (opens the in-page panel)
 *  - Persistent on every page; clicking it opens / toggles the card.
 *  - The pill itself is a hard-fixed 56×56 circular FAB (see CSS in
 *    injectAgentIndicator). Dragging moves it via left/top only and
 *    clamps it to the viewport; width/height are never changed.
 * ============================================================ */

function injectAgentIndicator(): void {
  if (document.getElementById("rv-agent-indicator")) return;

  const style = document.createElement("style");
  style.setAttribute("data-rv-indicator", "true");
  style.textContent = `
    #rv-agent-indicator {
      position: fixed;
      bottom: 20px;
      right: 20px;
      box-sizing: border-box;
      width: 56px;
      height: 56px;
      min-width: 56px;
      max-width: 56px;
      min-height: 56px;
      max-height: 56px;
      margin: 0;
      padding: 0;
      z-index: 2147483644;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
      border-radius: 50%;
      border: 2px solid rgba(255, 255, 255, 0.24);
      background: linear-gradient(135deg, #5b6bff 0%, #22d3a0 100%);
      box-shadow:
        0 10px 28px rgba(0, 0, 0, 0.45),
        0 0 0 2px rgba(7, 11, 24, 0.55),
        inset 0 1px 0 rgba(255, 255, 255, 0.18);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      pointer-events: auto;
      user-select: none;
      -webkit-user-select: none;
      touch-action: none;         /* so touch-drag doesn't scroll the page */
      cursor: grab;
      transition: transform 0.2s, box-shadow 0.2s, border-color 0.2s, opacity 0.18s ease;
    }
    #rv-agent-indicator img {
      width: 100%;
      height: 100%;
      flex: 0 0 100%;
      object-fit: cover;
      border-radius: 50%;
      display: block;
      pointer-events: none;
      user-select: none;
      -webkit-user-drag: none;
    }
    #rv-agent-indicator:hover {
      transform: scale(1.06);
      box-shadow:
        0 14px 34px rgba(0, 0, 0, 0.5),
        0 0 0 2px rgba(7, 11, 24, 0.55),
        inset 0 1px 0 rgba(255, 255, 255, 0.2),
        0 0 0 4px rgba(91, 107, 255, 0.35);
    }
    /* While dragging: suppress the hover lift and transition jank.
       Width/height are NEVER touched here — only left/top move. */
    #rv-agent-indicator.rv-dragging,
    #rv-agent-indicator.rv-dragging:hover {
      transform: none;
      cursor: grabbing;
      transition: none;
      box-shadow: 0 8px 22px rgba(0, 0, 0, 0.5), 0 0 0 2px rgba(91, 107, 255, 0.5);
    }
    /* Press feedback (0-160ms of the morph): slight grow + glow. The
       size stays 56x56 — only transform/box-shadow change. */
    #rv-agent-indicator.rv-press {
      transform: scale(1.12);
      cursor: grabbing;
      box-shadow:
        0 16px 40px rgba(0, 0, 0, 0.55),
        0 0 0 3px rgba(91, 107, 255, 0.55),
        0 0 22px rgba(91, 107, 255, 0.45),
        inset 0 1px 0 rgba(255, 255, 255, 0.25);
    }
    /* Hidden while the panel is morphed open (the launcher has become
       the panel header). opacity, not display, so the fade is smooth. */
    #rv-agent-indicator.rv-hidden {
      opacity: 0;
      pointer-events: none;
      transform: scale(0.5);
    }
  `;
  document.head.appendChild(style);

  const indicator = document.createElement("div");
  indicator.id = "rv-agent-indicator";
  indicator.setAttribute("role", "button");
  indicator.title = "RedactVision Agent — click to open, drag to move";
  indicator.innerHTML = `<img data-rv-pill-logo src="${rvLogoUrl()}" alt="RedactVision" draggable="false" />`;
  document.body.appendChild(indicator);

  // CSP-safe logo upgrade + SVG fallback (same hardening as the chat card).
  const pillLogo = indicator.querySelector(
    "img[data-rv-pill-logo]"
  ) as HTMLImageElement | null;
  if (pillLogo) {
    pillLogo.addEventListener("error", () => {
      if (pillLogo.src !== rvLogoUrl()) pillLogo.src = rvLogoUrl();
    });
    void upgradeLogoUrl(pillLogo, rvLogoUrl());
  }

  // ---- Drag: pointer events (mouse + touch), clamped to the viewport ----
  // Sub-threshold movement is treated as a click (toggles the chat open).
  const DRAG_CLICK_THRESHOLD = 5; // px
  let dragState: {
    pointerId: number;
    startX: number;
    startY: number;
    baseLeft: number;
    baseTop: number;
    moved: boolean;
  } | null = null;

  indicator.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    indicator.setPointerCapture(e.pointerId);
    const rect = indicator.getBoundingClientRect();
    dragState = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      baseLeft: rect.left,
      baseTop: rect.top,
      moved: false,
    };
  });

  indicator.addEventListener("pointermove", (e) => {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const dx = e.clientX - dragState.startX;
    const dy = e.clientY - dragState.startY;
    if (!dragState.moved && Math.hypot(dx, dy) < DRAG_CLICK_THRESHOLD) {
      return; // still a potential click
    }
    dragState.moved = true;
    indicator.classList.add("rv-dragging");

    // Switch to left/top anchoring and clamp to the visible viewport so
    // the pill can never be dragged off-screen.
    const maxX = Math.max(0, window.innerWidth - indicator.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - indicator.offsetHeight);
    const nx = Math.min(Math.max(0, dragState.baseLeft + dx), maxX);
    const ny = Math.min(Math.max(0, dragState.baseTop + dy), maxY);

    indicator.style.removeProperty("right");
    indicator.style.removeProperty("bottom");
    indicator.style.left = `${nx}px`;
    indicator.style.top = `${ny}px`;
  });

  const finishIndicatorDrag = (e: PointerEvent) => {
    if (!dragState || dragState.pointerId !== e.pointerId) return;
    const wasClick = !dragState.moved;
    const endLeft = dragState.baseLeft;
    dragState = null;
    indicator.classList.remove("rv-dragging");
    if (wasClick) {
      toggleLauncherPanel();
    } else {
      // Persist the dragged absolute position for this hostname under
      // the launcher's OWN key (never the chat card's OFFSET_KEY).
      const px = parseFloat(indicator.style.left || `${endLeft}`);
      const py = parseFloat(indicator.style.top || "0");
      if (Number.isFinite(px) && Number.isFinite(py)) setLauncherPos(px, py);
    }
  };

  indicator.addEventListener("pointerup", finishIndicatorDrag);
  indicator.addEventListener("pointercancel", finishIndicatorDrag);

  // Restore a previously dragged position (persisted per-hostname).
  // Values are absolute left/top px, clamped to the current viewport.
  void getLauncherPos().then(({ x, y }) => {
    if (x === null || y === null) return; // never dragged — keep default corner
    const maxX = Math.max(0, window.innerWidth - indicator.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - indicator.offsetHeight);
    indicator.style.left = `${Math.min(Math.max(0, x), maxX)}px`;
    indicator.style.top = `${Math.min(Math.max(0, y), maxY)}px`;
    indicator.style.right = "auto";
    indicator.style.bottom = "auto";
  });
}

/**
 * Launcher pill click → morph open / morph close.
 *  - closed  → open (panel grows out of the launcher).
 *  - open    → minimize (panel collapses back into the launcher).
 *  - opening/closing → ignored (rapid-click guard; the state machine
 *    always lands on a terminal state via finishOnTransition).
 */
function toggleLauncherPanel(): void {
  if (morphState === "open") {
    morphClose();
    return;
  }
  if (morphState !== "closed") return;
  void openInPagePanel();
}

/* ============================================================
 *  Widget visibility + settings application
 * ============================================================ */

function applyWidgetVisibility(visible: boolean): void {
  const launcher = document.getElementById("rv-agent-indicator");
  if (launcher) {
    (launcher as HTMLElement).style.display = visible ? "" : "none";
  }
  if (!visible && panel) {
    closeInPagePanel();
  }
}

function removeAgentUi(): void {
  closeInPagePanel();
  document.getElementById("rv-agent-indicator")?.remove();
}

/** Re-read dashboard settings and apply them live (popup → content). */
async function applyDashboardSettings(): Promise<void> {
  const s = await loadDashboardSettings();

  // Master switch — remove the UI entirely when off, inject when on.
  const whitelisted =
    s.domainWhitelist.length === 0 || s.domainWhitelist.includes(HOSTNAME);
  const shouldRun = s.active && whitelisted;
  const launcher = document.getElementById("rv-agent-indicator");
  if (shouldRun && !launcher) {
    injectAgentIndicator();
    applyWidgetVisibility(s.showWidget);
  } else if (!shouldRun) {
    removeAgentUi();
    return;
  }

  applyWidgetVisibility(s.showWidget);
  if (panel) {
    panel.session.setAutoRedact(s.autoRedact);
    panel.ui.applyTheme(s.theme);
  }
}

/* ============================================================
 *  Popup message bridge
 *  - The popup can ask for safe summaries only.
 *  - Original token map is NEVER sent.
 * ============================================================ */

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    try {
      if (typeof message !== "object" || message === null) return;
      const msg = message as { type?: string };

      if (msg.type === "GET_PRIVACY_STATUS") {
        const tokens = privacyFirewall.getLocalTokenMap().map((r) => ({
          token: r.token,
          type: r.type,
        }));
        sendResponse({
          tokenCount: tokens.length,
          tokens,
          sanitizedDOM: sanitizedPageDOM,
        });
        return true;
      }

      if (msg.type === "GET_SAFE_TOKENS") {
        const tokens = privacyFirewall.getLocalTokenMap().map((r) => ({
          token: r.token,
          type: r.type,
        }));
        sendResponse({ tokens });
        return true;
      }

      if (msg.type === "RV_SET_WIDGET_VISIBLE") {
        const visible = (msg as { visible?: boolean }).visible;
        void applyWidgetVisibility(visible !== false);
        return true;
      }

      if (msg.type === "RV_SETTINGS_UPDATED") {
        void applyDashboardSettings();
        return true;
      }
    } catch (err) {
      console.error("[RedactVision] Content: Message handler error:", err);
      try {
        sendResponse({ error: err instanceof Error ? err.message : String(err) });
      } catch {
        /* sendResponse may fail if context is invalidated */
      }
    }
  }
);

/* ============================================================
 *  Init — respect the dashboard settings before injecting anything.
 *  The launcher is only injected when the agent is active AND the
 *  host is allowed by the domain whitelist (if non-empty).
 * ============================================================ */

void (async function init() {
  const s = await loadDashboardSettings();
  const whitelisted =
    s.domainWhitelist.length === 0 || s.domainWhitelist.includes(HOSTNAME);
  if (!s.active || !whitelisted) {
    console.log("[RedactVision] Agent disabled for this page (settings/whitelist)");
    return;
  }
  injectAgentIndicator();
  applyWidgetVisibility(s.showWidget);
})();
