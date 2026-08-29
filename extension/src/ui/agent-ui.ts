/**
 * RedactVision Agent - Shared Agent UI Module
 *
 * Used by both the Chrome toolbar popup and the in-page agent panel.
 * Renders a consistent, agentic visual experience.
 *
 * Phase 6: Integrated with local state machine for consistent task orchestration.
 */

import { AgentState } from "../agent/state-machine";

/**
 * Map AgentState to UI display stages
 * Maintains backward compatibility with existing UI code
 */
export type AgentStage = AgentState;

export interface TokenRecordSafe {
  token: string;
  type: string;
  maskedHint?: string;
}

export interface AgentUIHandles {
  root: HTMLElement;
  setStage(stage: AgentStage, label: string): void;
  setStatus(dotClass: string, label: string): void;
  showPrivacyStage(tokens: TokenRecordSafe[]): void;
  showTokenizationStage(tokens: TokenRecordSafe[]): void;
  showSanitizedStage(): void;
  showAgentStage(): void;
  showActionStage(action: { type: string; target: string; confidence: number }): void;
  showValidationStage(passed: boolean, message?: string): void;
  showExecutionStage(executed: boolean, result?: string): void;
  reset(): void;
}

function buildHTML(): string {
  return `
    <div class="rv-agent-panel">
      <header class="rv-header">
        <div class="rv-header-left">
          <div class="rv-agent-icon">🤖</div>
          <div class="rv-header-text">
            <h1 class="rv-title">RedactVision Agent</h1>
            <div class="rv-status-row">
              <span class="rv-status-dot" id="rv-status-dot"></span>
              <span class="rv-status-label" id="rv-status-label">Ready</span>
            </div>
          </div>
        </div>
        <button type="button" class="rv-close-btn" id="rv-close-btn" aria-label="Close">×</button>
      </header>

      <section class="rv-prompt-stage rv-stage" id="rv-prompt-stage">
        <label class="rv-prompt-label" for="rv-prompt-input">Task Prompt</label>
        <textarea
          id="rv-prompt-input"
          class="rv-prompt-input"
          placeholder="e.g., Fill the profile form and submit it."
          rows="3"
        ></textarea>
        <button type="button" class="rv-send-btn" id="rv-send-btn">
          <span class="rv-send-icon">▶</span>
          <span class="rv-send-text">Run Task</span>
        </button>
      </section>

      <section class="rv-processing-stage rv-stage" id="rv-processing-stage" style="display:none">
        <div class="rv-processing-indicator">
          <div class="rv-processing-spinner"></div>
          <div class="rv-processing-text" id="rv-processing-text">Analyzing page...</div>
        </div>
        <div class="rv-processing-steps" id="rv-processing-steps"></div>
      </section>

      <section class="rv-results" id="rv-results" style="display:none">
        <div class="rv-result-section" id="rv-privacy-section" style="display:none">
          <h2 class="rv-section-title"><span>🔒</span> Privacy Firewall</h2>
          <div class="rv-privacy-count" id="rv-privacy-count"></div>
        </div>

        <div class="rv-result-section" id="rv-token-section" style="display:none">
          <h2 class="rv-section-title"><span>🛡️</span> Local Protection</h2>
          <div class="rv-token-list" id="rv-token-list"></div>
        </div>

        <div class="rv-result-section" id="rv-sanitized-section" style="display:none">
          <h2 class="rv-section-title"><span>✓</span> Sanitized Context</h2>
          <div class="rv-sanitized-info">
            <div class="rv-sanitized-item">✓ Sanitized payload ready</div>
            <div class="rv-sanitized-item">✓ Raw PII stays on device</div>
            <div class="rv-sanitized-item">✓ Local token map stays on device</div>
          </div>
        </div>

        <div class="rv-result-section" id="rv-agent-section" style="display:none">
          <h2 class="rv-section-title"><span>🤖</span> Agent Reasoning</h2>
          <div class="rv-mock-notice">Mock local response — no real server/VLM yet</div>
          <div class="rv-agent-info" id="rv-agent-info">
            <div class="rv-agent-row"><span>Waiting for agent...</span></div>
          </div>
        </div>

        <div class="rv-result-section" id="rv-action-section" style="display:none">
          <h2 class="rv-section-title"><span>⚡</span> Mock Agent Action</h2>
          <div class="rv-action-card" id="rv-action-card">
            <div class="rv-action-row">
              <span class="rv-action-label">Action:</span>
              <span class="rv-action-value" id="rv-action-type">CLICK</span>
            </div>
            <div class="rv-action-row">
              <span class="rv-action-label">Target:</span>
              <span class="rv-action-value rv-code" id="rv-action-target">#submit-btn</span>
            </div>
            <div class="rv-action-row">
              <span class="rv-action-label">Confidence:</span>
              <span class="rv-action-value" id="rv-action-confidence">98%</span>
            </div>
            <div class="rv-action-row">
              <span class="rv-action-label">Status:</span>
              <span class="rv-action-value rv-pending" id="rv-action-status">Mock response — not executed</span>
            </div>
          </div>
        </div>

        <div class="rv-result-section" id="rv-validation-section" style="display:none">
          <h2 class="rv-section-title"><span>✓</span> Action Validation</h2>
          <div class="rv-validation-card" id="rv-validation-card">
            <div class="rv-action-row">
              <span class="rv-action-label">Status:</span>
              <span class="rv-action-value" id="rv-validation-status">Pending</span>
            </div>
            <div class="rv-action-row">
              <span class="rv-action-label">Message:</span>
              <span class="rv-action-value" id="rv-validation-message">—</span>
            </div>
          </div>
        </div>

        <div class="rv-result-section" id="rv-execution-section" style="display:none">
          <h2 class="rv-section-title"><span>▶</span> Action Execution</h2>
          <div class="rv-execution-card" id="rv-execution-card">
            <div class="rv-action-row">
              <span class="rv-action-label">Status:</span>
              <span class="rv-action-value" id="rv-execution-status">Pending</span>
            </div>
            <div class="rv-action-row">
              <span class="rv-action-label">Result:</span>
              <span class="rv-action-value" id="rv-execution-result">—</span>
            </div>
          </div>
        </div>
      </section>

      <footer class="rv-footer">
        <div class="rv-footer-text">RedactVision Agent v0.1.0 • ByteForce</div>
      </footer>
    </div>
  `;
}

export function injectSharedStyles(doc: Document): void {
  if (doc.head.querySelector("style[data-rv-styles]")) {
    return;
  }

  const style = doc.createElement("style");
  style.setAttribute("data-rv-styles", "true");
  style.textContent = getSharedCSS();
  doc.head.appendChild(style);
}

function getSharedCSS(): string {
  return `
    .rv-agent-panel {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: linear-gradient(135deg, #0f172a 0%, #1e293b 100%);
      color: #e2e8f0;
      width: 100%;
      height: 100%;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
    }
    .rv-agent-panel *, .rv-agent-panel *::before, .rv-agent-panel *::after {
      box-sizing: border-box;
    }

    .rv-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 14px 16px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.2);
      flex-shrink: 0;
    }
    .rv-header-left { display: flex; align-items: center; gap: 12px; }
    .rv-agent-icon { font-size: 28px; filter: drop-shadow(0 0 8px rgba(59, 130, 246, 0.5)); }
    .rv-title { font-size: 16px; font-weight: 700; margin: 0; color: #f1f5f9; }
    .rv-status-row { display: flex; align-items: center; gap: 6px; margin-top: 2px; }
    .rv-status-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 8px rgba(34, 197, 94, 0.6);
      animation: rv-pulse 2s ease-in-out infinite;
    }
    .rv-status-dot.rv-analyzing { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.6); }
    .rv-status-dot.rv-sanitizing { background: #8b5cf6; box-shadow: 0 0 8px rgba(139, 92, 246, 0.6); }
    .rv-status-dot.rv-ready_to_send { background: #3b82f6; box-shadow: 0 0 8px rgba(59, 130, 246, 0.6); }
    .rv-status-dot.rv-waiting_for_agent { background: #3b82f6; box-shadow: 0 0 8px rgba(59, 130, 246, 0.6); }
    .rv-status-dot.rv-action_received { background: #3b82f6; box-shadow: 0 0 8px rgba(59, 130, 246, 0.6); }
    .rv-status-dot.rv-validating { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.6); }
    .rv-status-dot.rv-executing { background: #f59e0b; box-shadow: 0 0 8px rgba(245, 158, 11, 0.6); }
    .rv-status-dot.rv-completed { background: #22c55e; box-shadow: 0 0 8px rgba(34, 197, 94, 0.6); animation: none; }
    .rv-status-dot.rv-error { background: #ef4444; box-shadow: 0 0 8px rgba(239, 68, 68, 0.6); }
    @keyframes rv-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
    .rv-status-label { font-size: 12px; color: #94a3b8; font-weight: 500; }

    .rv-close-btn {
      background: rgba(148, 163, 184, 0.1);
      border: 1px solid rgba(148, 163, 184, 0.2);
      color: #cbd5e1;
      width: 28px; height: 28px;
      border-radius: 6px;
      font-size: 18px;
      line-height: 1;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center;
      transition: background 0.15s;
    }
    .rv-close-btn:hover { background: rgba(239, 68, 68, 0.2); color: #fca5a5; }

    .rv-stage { padding: 16px; flex-shrink: 0; }

    .rv-prompt-label {
      display: block;
      font-size: 11px;
      font-weight: 600;
      color: #94a3b8;
      margin-bottom: 8px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .rv-prompt-input {
      width: 100%;
      padding: 11px 12px;
      background: rgba(15, 23, 42, 0.6);
      border: 1px solid rgba(148, 163, 184, 0.2);
      border-radius: 8px;
      color: #e2e8f0;
      font-size: 13px;
      font-family: inherit;
      resize: none;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .rv-prompt-input:focus {
      outline: none;
      border-color: #3b82f6;
      box-shadow: 0 0 0 3px rgba(59, 130, 246, 0.1);
    }
    .rv-prompt-input::placeholder { color: #64748b; }
    .rv-send-btn {
      width: 100%;
      margin-top: 10px;
      padding: 11px;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      border: none;
      border-radius: 8px;
      color: white;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex; align-items: center; justify-content: center; gap: 8px;
      transition: transform 0.1s, box-shadow 0.2s;
    }
    .rv-send-btn:hover { transform: translateY(-1px); box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4); }
    .rv-send-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }
    .rv-send-icon { font-size: 11px; }

    .rv-processing-stage { display: flex; flex-direction: column; gap: 14px; }
    .rv-processing-indicator { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 24px 0; }
    .rv-processing-spinner {
      width: 40px; height: 40px;
      border: 3px solid rgba(59, 130, 246, 0.2);
      border-top-color: #3b82f6;
      border-radius: 50%;
      animation: rv-spin 0.8s linear infinite;
    }
    @keyframes rv-spin { to { transform: rotate(360deg); } }
    .rv-processing-text { font-size: 14px; color: #cbd5e1; font-weight: 500; }
    .rv-processing-steps { display: flex; flex-direction: column; gap: 8px; }
    .rv-processing-step {
      display: flex; align-items: center; gap: 10px;
      padding: 6px 0;
      font-size: 12px;
      color: #64748b;
      transition: color 0.2s, opacity 0.2s;
    }
    .rv-processing-step.rv-completed { color: #94a3b8; }
    .rv-processing-step.rv-active { color: #3b82f6; }
    .rv-processing-step-icon { width: 18px; text-align: center; font-weight: 600; }
    .rv-processing-step.rv-completed .rv-processing-step-icon { color: #22c55e; }
    .rv-processing-step.rv-active .rv-processing-step-icon { color: #3b82f6; animation: rv-pulse 1.2s ease-in-out infinite; }

    .rv-results { flex: 1; overflow-y: auto; padding: 0 16px 16px 16px; }
    .rv-results::-webkit-scrollbar { width: 6px; }
    .rv-results::-webkit-scrollbar-track { background: rgba(15, 23, 42, 0.4); }
    .rv-results::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.3); border-radius: 3px; }
    .rv-results::-webkit-scrollbar-thumb:hover { background: rgba(148, 163, 184, 0.5); }

    .rv-result-section {
      padding: 14px;
      background: rgba(15, 23, 42, 0.4);
      border-radius: 10px;
      border: 1px solid rgba(148, 163, 184, 0.1);
      margin-bottom: 10px;
      animation: rv-fade-in 0.3s ease-out;
    }
    @keyframes rv-fade-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
    .rv-section-title {
      font-size: 12px; font-weight: 600; color: #cbd5e1;
      margin: 0 0 10px 0;
      display: flex; align-items: center; gap: 8px;
    }

    .rv-privacy-count { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: #22c55e; }
    .rv-token-list { display: flex; flex-direction: column; gap: 6px; }
    .rv-token-item {
      display: flex; justify-content: space-between; align-items: center;
      padding: 8px 10px;
      background: rgba(0, 0, 0, 0.2);
      border-radius: 6px;
      font-size: 12px;
    }
    .rv-token-item-type { color: #94a3b8; font-weight: 500; text-transform: uppercase; font-size: 10px; }
    .rv-token-item-value {
      font-family: 'Courier New', monospace;
      color: #22c55e;
      background: rgba(34, 197, 94, 0.1);
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 11px;
    }
    .rv-token-item-hint { color: #64748b; font-size: 11px; }

    .rv-sanitized-info { display: flex; flex-direction: column; gap: 6px; }
    .rv-sanitized-item { font-size: 12px; color: #cbd5e1; }
    .rv-sanitized-item::before { content: "✓ "; color: #22c55e; font-weight: 600; }

    .rv-mock-notice {
      padding: 6px 10px;
      background: rgba(245, 158, 11, 0.1);
      border: 1px solid rgba(245, 158, 11, 0.2);
      border-radius: 6px;
      font-size: 11px;
      color: #fcd34d;
      margin-bottom: 10px;
    }
    .rv-agent-info { display: flex; flex-direction: column; gap: 6px; }
    .rv-agent-row { font-size: 12px; color: #cbd5e1; }

    .rv-action-card { display: flex; flex-direction: column; gap: 6px; }
    .rv-validation-card { display: flex; flex-direction: column; gap: 6px; }
    .rv-execution-card { display: flex; flex-direction: column; gap: 6px; }
    .rv-action-row {
      display: flex; justify-content: space-between; align-items: center;
      padding: 5px 0; font-size: 12px;
      border-bottom: 1px solid rgba(148, 163, 184, 0.1);
    }
    .rv-action-row:last-child { border-bottom: none; }
    .rv-action-label { color: #94a3b8; font-weight: 500; }
    .rv-action-value { color: #e2e8f0; font-weight: 600; }
    .rv-action-value.rv-code {
      font-family: 'Courier New', monospace;
      background: rgba(59, 130, 246, 0.1);
      padding: 2px 8px;
      border-radius: 4px;
      color: #60a5fa;
    }
    .rv-action-value.rv-pending { color: #f59e0b; }
    .rv-action-value.rv-completed { color: #22c55e; }

    .rv-footer {
      padding: 10px 16px;
      border-top: 1px solid rgba(148, 163, 184, 0.1);
      text-align: center;
      flex-shrink: 0;
    }
    .rv-footer-text { font-size: 10px; color: #64748b; }
  `;
}

export function buildAgentUI(container: HTMLElement): AgentUIHandles {
  container.innerHTML = buildHTML();

  const root = container.querySelector(".rv-agent-panel") as HTMLElement;
  const promptStage = root.querySelector("#rv-prompt-stage") as HTMLElement;
  const processingStage = root.querySelector("#rv-processing-stage") as HTMLElement;
  const processingSteps = root.querySelector("#rv-processing-steps") as HTMLElement;
  const results = root.querySelector("#rv-results") as HTMLElement;
  const statusDot = root.querySelector("#rv-status-dot") as HTMLElement;
  const statusLabel = root.querySelector("#rv-status-label") as HTMLElement;
  const closeBtn = root.querySelector("#rv-close-btn") as HTMLElement;

  closeBtn.addEventListener("click", () => {
    const event = new CustomEvent("rv-close", { bubbles: true });
    root.dispatchEvent(event);
  });

  function setStatus(dotClass: string, label: string): void {
    statusDot.className = "rv-status-dot";
    if (dotClass) {
      statusDot.classList.add(dotClass);
    }
    statusLabel.textContent = label;
  }

  function setStage(stage: AgentStage, label: string): void {
    const dotClass = stage === "idle" ? "" : `rv-${stage}`;
    setStatus(dotClass, label);
  }

  function reset(): void {
    promptStage.style.display = "block";
    processingStage.style.display = "none";
    results.style.display = "none";
    processingSteps.innerHTML = "";
    setStage("idle", "Ready");
    const sections = [
      "rv-privacy-section",
      "rv-token-section",
      "rv-sanitized-section",
      "rv-agent-section",
      "rv-action-section",
      "rv-validation-section",
      "rv-execution-section",
    ];
    for (const id of sections) {
      const el = root.querySelector(`#${id}`) as HTMLElement | null;
      if (el) el.style.display = "none";
    }
  }

  function revealSection(id: string): void {
    const el = root.querySelector(`#${id}`) as HTMLElement | null;
    if (el) el.style.display = "block";
  }

  function showPrivacyStage(tokens: TokenRecordSafe[]): void {
    const countEl = root.querySelector("#rv-privacy-count") as HTMLElement;
    countEl.innerHTML = `<span>✓</span> ${tokens.length} sensitive value${tokens.length !== 1 ? "s" : ""} detected & protected locally`;
    revealSection("rv-privacy-section");
  }

  function showTokenizationStage(tokens: TokenRecordSafe[]): void {
    const listEl = root.querySelector("#rv-token-list") as HTMLElement;
    if (tokens.length === 0) {
      listEl.innerHTML = `<div class="rv-token-item"><span class="rv-token-item-type">No tokens</span></div>`;
    } else {
      listEl.innerHTML = tokens
        .map(
          (t) => `<div class="rv-token-item">
        <span class="rv-token-item-type">${t.type}</span>
        <span>${t.maskedHint ? `<span class="rv-token-item-hint">${t.maskedHint}</span> → ` : ""}<span class="rv-token-item-value">${t.token}</span></span>
      </div>`
        )
        .join("");
    }
    revealSection("rv-token-section");
  }

  function showSanitizedStage(): void {
    revealSection("rv-sanitized-section");
  }

  function showAgentStage(): void {
    const info = root.querySelector("#rv-agent-info") as HTMLElement;
    info.innerHTML = `<div class="rv-agent-row">Local mock — no real network call yet</div>`;
    revealSection("rv-agent-section");
  }

  function showActionStage(action: { type: string; target: string; confidence: number }): void {
    const typeEl = root.querySelector("#rv-action-type") as HTMLElement;
    const targetEl = root.querySelector("#rv-action-target") as HTMLElement;
    const confEl = root.querySelector("#rv-action-confidence") as HTMLElement;
    const statusEl = root.querySelector("#rv-action-status") as HTMLElement;
    typeEl.textContent = action.type.toUpperCase();
    targetEl.textContent = action.target;
    confEl.textContent = `${Math.round(action.confidence * 100)}%`;
    statusEl.textContent = "Mock response — not executed";
    revealSection("rv-action-section");
  }

  function showValidationStage(passed: boolean, message?: string): void {
    const statusEl = root.querySelector("#rv-validation-status") as HTMLElement;
    const messageEl = root.querySelector("#rv-validation-message") as HTMLElement;
    statusEl.textContent = passed ? "✓ Passed" : "✗ Failed";
    statusEl.className = `rv-action-value ${passed ? "rv-completed" : "rv-pending"}`;
    messageEl.textContent = message || (passed ? "Action validated locally" : "Action failed validation");
    revealSection("rv-validation-section");
  }

  function showExecutionStage(executed: boolean, result?: string): void {
    const statusEl = root.querySelector("#rv-execution-status") as HTMLElement;
    const resultEl = root.querySelector("#rv-execution-result") as HTMLElement;
    statusEl.textContent = executed ? "✓ Executed" : "✗ Failed";
    statusEl.className = `rv-action-value ${executed ? "rv-completed" : "rv-pending"}`;
    resultEl.textContent = result || (executed ? "Action executed in browser" : "Execution failed");
    revealSection("rv-execution-section");
  }

  return {
    root,
    setStage,
    setStatus,
    showPrivacyStage,
    showTokenizationStage,
    showSanitizedStage,
    showAgentStage,
    showActionStage,
    showValidationStage,
    showExecutionStage,
    reset,
  };
}

export function makeSafeHint(raw: string, type: string): string {
  if (!raw) return "";
  if (type === "EMAIL") {
    const [user, domain] = raw.split("@");
    const tld = domain?.split(".").pop() ?? "";
    const maskedUser = user.length <= 2 ? user[0] + "*" : user.slice(0, 3) + "***";
    return `${maskedUser}@${"***"}.${tld}`;
  }
  if (type === "PHONE") {
    return raw.length > 4 ? "***" + raw.slice(-4) : "***";
  }
  if (type === "PASSWORD") {
    return "••••••••";
  }
  if (type === "PERSON") {
    return raw.length > 1 ? raw[0] + "***" + raw[raw.length - 1] : "***";
  }
  return "***";
}

export interface AgentFlowHooks {
  onStageStart(stage: AgentStage, label: string, stepText: string): void;
  onStageComplete(stage: AgentStage): void;
  onPrivacy(tokens: TokenRecordSafe[]): void;
  onTokenization(tokens: TokenRecordSafe[]): void;
  onSanitized(): void;
  onAgent(): void;
  onAction(): void;
  onValidation?(passed: boolean, message?: string): void;
  onExecution?(executed: boolean, result?: string): void;
  onDone(): void;
  onError(): void;
}

const PIPELINE: Array<{
  stage: AgentStage;
  label: string;
  stepText: string;
  duration: number;
}> = [
  { stage: "analyzing", label: "Analyzing page...", stepText: "Page analyzed", duration: 900 },
  { stage: "sanitizing", label: "Protecting sensitive data...", stepText: "Sensitive data protected", duration: 1100 },
  { stage: "ready_to_send", label: "Preparing secure context...", stepText: "Sanitized context ready", duration: 800 },
  { stage: "waiting_for_agent", label: "Waiting for agent...", stepText: "Agent reasoning (mock)", duration: 1400 },
  { stage: "action_received", label: "Action received", stepText: "Action ready", duration: 600 },
  { stage: "validating", label: "Validating action...", stepText: "Action validated", duration: 500 },
  { stage: "executing", label: "Executing action...", stepText: "Action executed", duration: 700 },
];

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function runAgentFlow(
  tokens: TokenRecordSafe[],
  hooks: AgentFlowHooks,
  signal?: { cancelled: boolean }
): Promise<void> {
  for (let i = 0; i < PIPELINE.length; i++) {
    if (signal?.cancelled) return;
    const step = PIPELINE[i];
    hooks.onStageStart(step.stage, step.label, step.stepText);
    await delay(step.duration);
    if (signal?.cancelled) return;
    hooks.onStageComplete(step.stage);

    if (step.stage === "sanitizing") {
      hooks.onPrivacy(tokens);
    } else if (step.stage === "ready_to_send") {
      hooks.onTokenization(tokens);
      hooks.onSanitized();
    } else if (step.stage === "waiting_for_agent") {
      hooks.onAgent();
    } else if (step.stage === "action_received") {
      hooks.onAction();
    } else if (step.stage === "validating") {
      hooks.onValidation?.(true, "Mock validation passed");
    } else if (step.stage === "executing") {
      hooks.onExecution?.(true, "Mock execution completed");
      hooks.onDone();
    }
  }
}
