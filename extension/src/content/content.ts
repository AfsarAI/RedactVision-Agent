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
} from "../ui/chat-ui";
import {
  loadPlannerConfig,
  savePlannerConfig,
  PlannerConfig,
} from "../llm/llm-planner";

console.log("RedactVision Agent: Content Script Loaded");

/* ============================================================
 *  Local perception + privacy firewall (run once on page load)
 *  - rawPageDOM is NEVER sent to the server.
 *  - sanitizedPageDOM is the only thing that can leave the device.
 * ============================================================ */

const privacyFirewall = new PrivacyFirewall();
const sanitizedPageDOM = privacyFirewall.sanitizePage(extractPageDOM());

console.log("RedactVision Agent: Sanitized Page DOM");
console.log(sanitizedPageDOM);
console.log(
  "RedactVision Agent: Local Token Count",
  privacyFirewall.getLocalTokenMap().length
);
console.log(
  "RedactVision Agent: Local Token Map",
  privacyFirewall.getLocalTokenMap()
);

/* ============================================================
 *  Stylesheet injection
 *  - Fetch the shared chat-ui.css from the extension at runtime so
 *    we don't ship a hand-duplicated 270-line CSS blob.
 *  - On failure (e.g. file:// URLs), fall back to a minimal inline
 *    style so the card is at least usable.
 * ============================================================ */

const STYLE_TAG_ID = "rv-chat-styles";
const STYLE_FALLBACK = `
  .rv-chat { position:fixed;bottom:90px;right:20px;width:380px;height:580px;
    background:#131a30;color:#e6ecff;border:1px solid #2a3155;border-radius:16px;
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","SF Pro Text",Inter,Roboto,sans-serif;
    font-size:13px;z-index:2147483646;display:flex;flex-direction:column;overflow:hidden;
    box-shadow:0 20px 25px -5px rgba(0,0,0,.5),0 8px 10px -6px rgba(0,0,0,.4);
  }
  .rv-chat-header{display:flex;align-items:center;gap:10px;padding:12px 14px 11px;border-bottom:1px solid #2a3155;flex-shrink:0;cursor:grab;user-select:none}
  .rv-chat-brand{display:flex;align-items:center;gap:9px;flex:1;min-width:0}
  .rv-chat-avatar{width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;letter-spacing:.5px;color:#fff;background:linear-gradient(135deg,#5b6bff,#22d3a0);border-radius:8px;box-shadow:0 2px 8px rgba(91,107,255,.4);flex-shrink:0}
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
      const cssUrl = chrome.runtime.getURL("ui/chat-ui.css");
      const resp = await fetch(cssUrl);
      if (resp.ok) css = await resp.text();
    } catch (e) {
      console.warn(
        "[RedactVision] Could not load chat-ui.css from extension bundle, using bundled fallback:",
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
        const o = data?.[OFFSET_KEY] as { dx?: number; dy?: number } | undefined;
        if (o && typeof o.dx === "number" && typeof o.dy === "number") {
          resolve({ dx: o.dx, dy: o.dy });
        } else {
          resolve({ dx: 0, dy: 0 });
        }
      });
    } catch {
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

async function openInPagePanel(): Promise<void> {
  if (panel) {
    // Already open — restore from minimized state and refocus.
    panel.ui.setMinimized(false);
    panel.root.style.display = "flex";
    panel.ui.focusInput();
    return;
  }

  await injectChatStyles();
  await openInPagePanelAsync();
}

async function openInPagePanelAsync(): Promise<void> {
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

  // Restore persisted drag offset.
  const offset = await getStoredOffset();
  ui.setDragOffset(offset.dx, offset.dy);

  // Load planner config.
  const config: PlannerConfig = await loadPlannerConfig();

  const session = new AgentSession(
    {
      onActivity: (activity) => ui.appendActivity(activity),
      onPlanResult: (result) => {
        // The planner may return undefined (e.g. pure error). Default to
        // a label derived from the source.
        const label =
          result.backendLabel ||
          (result.source === "server-llm"
            ? "Server"
            : result.source === "fallback-rules"
            ? "Local rules"
            : "—");
        ui.setBackend(label);
      },
    },
    config
  );

  const sessionSignal = { cancelled: false };

  // Render the initial redaction summary using whatever the privacy
  // firewall found on the first page scan.
  const initialSummary: RedactionSummary = session.getRedactionSummary(false);
  ui.setRedactionSummary(initialSummary);

  ui.setStatus("ready", "Ready");
  ui.clearConversation();
  ui.setBackend("Local"); // initial state, replaced on first plan

  ui.onSend(async (text) => {
    ui.setInputValue("");
    ui.setInputEnabled(false);
    ui.setStatus("thinking", "Working…");
    try {
      await session.runPrompt(text);
      // After the prompt, re-summarize (page state may have changed).
      ui.setRedactionSummary(session.getRedactionSummary(false));
      ui.setStatus("completed", "Completed");
    } catch (err) {
      ui.setStatus("error", "Error");
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
    ui.setMinimized(true);
  });

  ui.onClose(() => {
    closeInPagePanel();
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

function closeInPagePanel(): void {
  if (!panel) return;
  panel.session.cancel();
  panel.overlay.remove();
  panel = null;
}

/* ============================================================
 *  Floating launcher pill (opens the in-page panel)
 *  - Persistent on every page; clicking it opens (or restores) the card.
 *  - Draggable launcher is NOT supported — the launcher is a fixed
 *    point of entry; the card itself is what the user drags.
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
      z-index: 2147483644;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: transform 0.2s, box-shadow 0.2s;
      pointer-events: auto;
    }
    #rv-agent-indicator:hover {
      transform: translateY(-2px);
    }
    .rv-indicator-inner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px 8px 12px;
      background: linear-gradient(135deg, #0e1428 0%, #131a30 100%);
      border: 1px solid rgba(91, 107, 255, 0.4);
      border-radius: 999px;
      box-shadow: 0 6px 22px rgba(0, 0, 0, 0.5);
      font-size: 12.5px;
      font-weight: 500;
      color: #e6ecff;
      backdrop-filter: blur(10px);
    }
    .rv-indicator-icon {
      width: 22px;
      height: 22px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.5px;
      color: white;
      background: linear-gradient(135deg, #5b6bff 0%, #22d3a0 100%);
      border-radius: 6px;
    }
    .rv-indicator-name { color: #e6ecff; font-weight: 600; }
    .rv-indicator-status {
      color: #22d3a0;
      font-size: 10.5px;
      margin-left: 2px;
      display: inline-flex;
      align-items: center;
      gap: 4px;
    }
    .rv-indicator-status::before {
      content: "";
      width: 5px;
      height: 5px;
      border-radius: 50%;
      background: #22d3a0;
      box-shadow: 0 0 4px #22d3a0;
    }
  `;
  document.head.appendChild(style);

  const indicator = document.createElement("div");
  indicator.id = "rv-agent-indicator";
  indicator.innerHTML = `
    <div class="rv-indicator-inner">
      <span class="rv-indicator-icon">RV</span>
      <span class="rv-indicator-name">RedactVision</span>
      <span class="rv-indicator-status">Ready</span>
    </div>
  `;
  document.body.appendChild(indicator);

  indicator.addEventListener("click", () => {
    void openInPagePanel();
  });
}

injectAgentIndicator();

/* ============================================================
 *  Popup message bridge
 *  - The popup can ask for safe summaries only.
 *  - Original token map is NEVER sent.
 * ============================================================ */

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
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
  }
);
