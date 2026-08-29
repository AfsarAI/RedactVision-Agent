import { extractPageDOM } from "./dom-extractor";
import { PrivacyFirewall } from "../privacy/privacy-firewall";
import {
  AgentUIHandles,
  TokenRecordSafe,
  buildAgentUI,
  injectSharedStyles,
  makeSafeHint,
  runAgentFlow,
} from "../ui/agent-ui";
import { runRealAgentFlow } from "../server/real-agent-flow";

console.log("RedactVision Agent: Content Script Loaded");

// Configuration: Set to true to use real server, false for mock
const USE_REAL_SERVER = true;
const SERVER_URL = "ws://127.0.0.1:8001/ws/agent";

/*
 * Capture raw DOM locally.
 */
const rawPageDOM = extractPageDOM();

/*
 * Run privacy firewall locally.
 */
const privacyFirewall = new PrivacyFirewall();

const sanitizedPageDOM = privacyFirewall.sanitizePage(rawPageDOM);

/*
 * Do NOT log rawPageDOM.
 *
 * Future server communication must use
 * sanitizedPageDOM only.
 */
console.log("RedactVision Agent: Sanitized Page DOM");
console.log(sanitizedPageDOM);

/*
 * LOCAL ONLY.
 *
 * This is for development/testing.
 * The token map must never be sent to
 * the server.
 */
console.log(
  "RedactVision Agent: Local Token Count",
  privacyFirewall.getLocalTokenMap().length
);
console.log(
  "RedactVision Agent: Local Token Map",
  privacyFirewall.getLocalTokenMap()
);

/* ============================================================
 *  In-page floating agent indicator + panel
 *  --------------------------------------------------------
 *  This stays inside the page DOM. It does NOT open
 *  chrome-extension:// URLs.
 * ============================================================ */

let inPagePanel: { root: HTMLElement; handles: AgentUIHandles; flowSignal: { cancelled: boolean } } | null = null;

/**
 * Build a safe summary of the local token map.
 * NEVER include original sensitive values in the network-facing response.
 * The maskedHint is for local prototype display only and is stripped before any future transmission.
 */
function getSafeTokenSummary(): TokenRecordSafe[] {
  return privacyFirewall.getLocalTokenMap().map((record) => ({
    token: record.token,
    type: record.type,
    // Local-only masked hint for prototype display.
    // Do NOT include in any future server payload.
    maskedHint: makeSafeHint(record.originalValue, record.type),
  }));
}

/**
 * Open the in-page agent panel as an overlay.
 * The panel lives inside the page DOM (not a new window/tab).
 */
function openInPagePanel(): void {
  if (inPagePanel) {
    // Already open — just bring it to front
    inPagePanel.root.style.display = "block";
    return;
  }

  injectSharedStyles(document);

  const overlay = document.createElement("div");
  overlay.id = "rv-inpage-overlay";
  overlay.style.cssText = `
    position: fixed;
    top: 0; right: 0; bottom: 0;
    width: 380px;
    z-index: 2147483646;
    box-shadow: -4px 0 24px rgba(0, 0, 0, 0.4);
    display: flex;
    flex-direction: column;
    background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
    border-left: 1px solid rgba(148, 163, 184, 0.2);
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  `;

  document.body.appendChild(overlay);

  const handles = buildAgentUI(overlay);
  const flowSignal = { cancelled: false };

  handles.root.addEventListener("rv-close", () => {
    closeInPagePanel();
  });

  wirePromptHandlers(handles, flowSignal);

  inPagePanel = { root: overlay, handles, flowSignal };
}

function closeInPagePanel(): void {
  if (!inPagePanel) return;
  inPagePanel.flowSignal.cancelled = true;
  inPagePanel.root.remove();
  inPagePanel = null;
}

/**
 * Wire the in-page or popup prompt to the simulated agent flow.
 */
function wirePromptHandlers(handles: AgentUIHandles, signal: { cancelled: boolean }): void {
  const promptStage = handles.root.querySelector("#rv-prompt-stage") as HTMLElement;
  const processingStage = handles.root.querySelector("#rv-processing-stage") as HTMLElement;
  const processingText = handles.root.querySelector("#rv-processing-text") as HTMLElement;
  const results = handles.root.querySelector("#rv-results") as HTMLElement;
  const sendBtn = handles.root.querySelector("#rv-send-btn") as HTMLButtonElement;
  const promptInput = handles.root.querySelector("#rv-prompt-input") as HTMLTextAreaElement;
  const processingSteps = handles.root.querySelector("#rv-processing-steps") as HTMLElement;

  function addStep(text: string, state: "completed" | "active" | "pending"): void {
    const step = document.createElement("div");
    step.className = `rv-processing-step ${state === "pending" ? "" : `rv-${state}`}`;
    const icon = state === "completed" ? "✓" : state === "active" ? "◌" : "○";
    step.innerHTML = `<span class="rv-processing-step-icon">${icon}</span><span>${text}</span>`;
    processingSteps.appendChild(step);
  }

  function reset(): void {
    handles.reset();
    promptStage.style.display = "block";
    processingStage.style.display = "none";
    results.style.display = "none";
    processingSteps.innerHTML = "";
  }

  function startFlow(): void {
    const text = promptInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    promptInput.disabled = true;
    promptStage.style.display = "none";
    processingStage.style.display = "flex";
    results.style.display = "block";
    processingSteps.innerHTML = "";

    if (USE_REAL_SERVER) {
      // Use real server flow
      runRealAgentFlow(
        sanitizedPageDOM,
        privacyFirewall,
        text,
        {
          serverUrl: SERVER_URL,
          onStageStart: (_stage, label, stepText) => {
            processingText.textContent = label;
            addStep(stepText, "active");
          },
          onStageComplete: (_stage) => {
            const lastStep = processingSteps.lastElementChild as HTMLElement | null;
            if (lastStep) {
              lastStep.classList.remove("rv-active");
              lastStep.classList.add("rv-completed");
            }
          },
          onPrivacy: (t) => handles.showPrivacyStage(t as TokenRecordSafe[]),
          onTokenization: (t) => handles.showTokenizationStage(t as TokenRecordSafe[]),
          onSanitized: () => handles.showSanitizedStage(),
          onConnecting: () => {
            handles.showAgentStage();
          },
          onConnected: () => {
            const agentSection = handles.root.querySelector("#rv-agent-section");
            if (agentSection) {
              agentSection.innerHTML = `
                <h2 class="rv-section-title"><span>🤖</span> Server Connected</h2>
                <div class="rv-agent-info">
                  <div class="rv-agent-row">✓ Connected to RedactVision server</div>
                  <div class="rv-agent-row" style="font-size:11px;color:#94a3b8">Waiting for agent reasoning...</div>
                </div>
              `;
              (agentSection as HTMLElement).style.display = "block";
            }
          },
          onServerAction: (action) => {
            handles.showActionStage({
              type: action.action,
              target: action.target,
              confidence: action.confidence,
            });
          },
          onValidation: (passed, message) => {
            handles.showValidationStage(passed, message);
          },
          onExecution: (executed, result) => {
            console.log("[ContentScript] onExecution called:", executed, result);
            try {
              handles.showExecutionStage(executed, result);
              // Hide the processing stage spinner/text
              const processingStage = handles.root.querySelector("#rv-processing-stage") as HTMLElement;
              if (processingStage) {
                processingStage.style.display = "none";
              }
              console.log("[ContentScript] showExecutionStage completed");
            } catch (err) {
              console.error("[ContentScript] Error in showExecutionStage:", err);
            }
          },
          onDone: () => {
            console.log("[ContentScript] onDone called - should show completed");
            try {
              sendBtn.disabled = false;
              promptInput.disabled = false;
              handles.setStage("completed", "Completed");
              // Ensure processing stage is hidden
              const processingStage = handles.root.querySelector("#rv-processing-stage") as HTMLElement;
              if (processingStage) {
                processingStage.style.display = "none";
              }
              console.log("[ContentScript] setStage completed completed");
            } catch (err) {
              console.error("[ContentScript] Error in onDone:", err);
            }
          },
          onError: (error) => {
            sendBtn.disabled = false;
            promptInput.disabled = false;
            handles.setStage("error", `Error: ${error}`);
            console.error("[ContentScript] Agent flow error:", error);
          },
        },
        signal
      ).catch((err) => {
        console.error("[ContentScript] Unexpected error:", err);
        sendBtn.disabled = false;
        promptInput.disabled = false;
        handles.setStage("error", "Unexpected error");
      });
    } else {
      // Use mock flow (Phase 5/6 behavior)
      const tokens = getSafeTokenSummary();

      runAgentFlow(
        tokens,
        {
          onStageStart: (_stage, label, stepText) => {
            processingText.textContent = label;
            addStep(stepText, "active");
          },
          onStageComplete: (_stage) => {
            const lastStep = processingSteps.lastElementChild as HTMLElement | null;
            if (lastStep) {
              lastStep.classList.remove("rv-active");
              lastStep.classList.add("rv-completed");
            }
          },
          onPrivacy: (t) => handles.showPrivacyStage(t),
          onTokenization: (t) => handles.showTokenizationStage(t),
          onSanitized: () => handles.showSanitizedStage(),
          onAgent: () => handles.showAgentStage(),
          onAction: () => {
            const t = promptInput.value.toLowerCase();
            let action = { type: "CLICK", target: "#submit-btn", confidence: 0.98 };
            if (t.includes("fill") || t.includes("enter") || t.includes("type")) {
              action = { type: "TYPE", target: "#full-name", confidence: 0.95 };
            } else if (t.includes("cancel")) {
              action = { type: "CLICK", target: "#cancel-btn", confidence: 0.99 };
            } else if (t.includes("phone")) {
              action = { type: "TYPE", target: "#phone", confidence: 0.94 };
            } else if (t.includes("email")) {
              action = { type: "TYPE", target: "#email", confidence: 0.97 };
            } else if (t.includes("password")) {
              action = { type: "TYPE", target: "#password", confidence: 0.93 };
            }
            handles.showActionStage(action);
          },
          onValidation: (passed, message) => {
            handles.showValidationStage(passed, message);
          },
          onExecution: (executed, result) => {
            handles.showExecutionStage(executed, result);
          },
          onDone: () => {
            sendBtn.disabled = false;
            promptInput.disabled = false;
            handles.setStage("completed", "Completed");
          },
          onError: () => {
            sendBtn.disabled = false;
            promptInput.disabled = false;
            handles.setStage("error", "Error");
          },
        },
        signal
      ).catch(() => {
        sendBtn.disabled = false;
        promptInput.disabled = false;
      });
    }
  }

  sendBtn.addEventListener("click", startFlow);
  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      startFlow();
    }
  });

  // Expose reset for the popup to trigger
  (handles as unknown as { __reset?: () => void }).__reset = reset;
}

/**
 * Inject the floating indicator button that opens the in-page panel.
 */
function injectAgentIndicator(): void {
  if (document.getElementById("rv-agent-indicator")) return;

  const style = document.createElement("style");
  style.setAttribute("data-rv-indicator", "true");
  style.textContent = `
    #rv-agent-indicator {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483645;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: transform 0.2s, box-shadow 0.2s;
    }
    #rv-agent-indicator:hover {
      transform: translateY(-2px);
      box-shadow: 0 6px 24px rgba(59, 130, 246, 0.4);
    }
    .rv-indicator-inner {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 9px 16px;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      border: 1px solid rgba(59, 130, 246, 0.4);
      border-radius: 24px;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
      font-size: 13px;
      font-weight: 500;
      color: #e2e8f0;
    }
    .rv-indicator-icon {
      font-size: 16px;
      filter: drop-shadow(0 0 4px rgba(59, 130, 246, 0.5));
    }
    .rv-indicator-name { color: #e2e8f0; font-weight: 600; }
    .rv-indicator-status {
      color: #22c55e;
      font-size: 12px;
      margin-left: 4px;
    }
  `;
  document.head.appendChild(style);

  const indicator = document.createElement("div");
  indicator.id = "rv-agent-indicator";
  indicator.innerHTML = `
    <div class="rv-indicator-inner">
      <span class="rv-indicator-icon">🤖</span>
      <span class="rv-indicator-name">RedactVision Agent</span>
      <span class="rv-indicator-status">● Ready</span>
    </div>
  `;
  document.body.appendChild(indicator);

  indicator.addEventListener("click", openInPagePanel);
}

injectAgentIndicator();

/* ============================================================
 *  Message handler for the Chrome toolbar popup
 *  --------------------------------------------------------
 *  The popup requests SAFE summaries only:
 *  - token count
 *  - token types + tokens
 *  - sanitized DOM
 *
 *  The original token map is NEVER sent.
 *  No chrome-extension:// windows are opened from here.
 * ============================================================ */

chrome.runtime.onMessage.addListener(
  (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (typeof message !== "object" || message === null) {
      return;
    }

    const msg = message as { type?: string };

    if (msg.type === "GET_PRIVACY_STATUS") {
      sendResponse({
        tokenCount: privacyFirewall.getLocalTokenMap().length,
        tokens: getSafeTokenSummary(),
        sanitizedDOM: sanitizedPageDOM,
      });
      return true;
    }

    if (msg.type === "GET_SAFE_TOKENS") {
      sendResponse({
        tokens: getSafeTokenSummary(),
      });
      return true;
    }
  }
);
