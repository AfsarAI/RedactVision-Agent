/**
 * RedactVision Agent - Chrome Toolbar Popup Controller
 *
 * This popup uses the shared agent UI module to provide
 * a consistent experience with the in-page panel.
 */

import {
  AgentUIHandles,
  TokenRecordSafe,
  buildAgentUI,
  injectSharedStyles,
  runAgentFlow,
} from "../ui/agent-ui";

// Initialize on DOMContentLoaded
document.addEventListener("DOMContentLoaded", () => {
  // Inject styles into popup document
  injectSharedStyles(document);

  // Build UI
  const container = document.body;
  const handles = buildAgentUI(container);
  const flowSignal = { cancelled: false };

  // Wire handlers
  wirePopupHandlers(handles, flowSignal);

  // Request initial privacy status from active tab
  requestPrivacyStatus();
});

/**
 * Request privacy status from the content script
 */
async function requestPrivacyStatus(): Promise<TokenRecordSafe[]> {
  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (!tab?.id) {
      return [];
    }

    const response = await chrome.tabs.sendMessage(tab.id, {
      type: "GET_SAFE_TOKENS",
    });

    if (response && "tokens" in response) {
      return response.tokens as TokenRecordSafe[];
    }

    return [];
  } catch (error) {
    console.log("Content script not ready:", error);
    return [];
  }
}

/**
 * Wire the popup prompt to the simulated agent flow.
 */
function wirePopupHandlers(handles: AgentUIHandles, signal: { cancelled: boolean }): void {
  const promptStage = handles.root.querySelector("#rv-prompt-stage") as HTMLElement;
  const processingStage = handles.root.querySelector("#rv-processing-stage") as HTMLElement;
  const processingText = handles.root.querySelector("#rv-processing-text") as HTMLElement;
  const results = handles.root.querySelector("#rv-results") as HTMLElement;
  const sendBtn = handles.root.querySelector("#rv-send-btn") as HTMLButtonElement;
  const promptInput = handles.root.querySelector("#rv-prompt-input") as HTMLTextAreaElement;
  const processingSteps = handles.root.querySelector("#rv-processing-steps") as HTMLElement;
  const closeBtn = handles.root.querySelector("#rv-close-btn") as HTMLButtonElement;

  // Hide close button in popup (only needed in in-page panel)
  closeBtn.style.display = "none";

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

  async function startFlow(): Promise<void> {
    const text = promptInput.value.trim();
    if (!text) return;

    sendBtn.disabled = true;
    promptInput.disabled = true;
    promptStage.style.display = "none";
    processingStage.style.display = "flex";
    results.style.display = "block";
    processingSteps.innerHTML = "";

    const tokens = await requestPrivacyStatus();

    await runAgentFlow(
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

  sendBtn.addEventListener("click", () => {
    startFlow().catch(console.error);
  });

  promptInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      startFlow().catch(console.error);
    }
  });
}
