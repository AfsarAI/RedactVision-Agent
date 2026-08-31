/**
 * RedactVision Agent — In-page Chat Widget
 *
 * Renders the floating chatbot card that lives inside the host page.
 * The toolbar popup is now a separate settings dashboard; this module
 * is responsible only for the agentic chat experience.
 *
 * Visual blocks (in order of presentation):
 *   - Privacy bar (top accent, breathes when sanitizing)
 *   - Header: brand, status, backend pill, minimize, close
 *   - Conversation:
 *       • User messages  — right-aligned indigo pill
 *       • Live processing view — compact timeline while the agent is working
 *       • Completion / failure summary — the polished "result" card
 *       • Action blocks — planned / validated / executed / rejected
 *       • Redaction summary card — lock/shield pills for each token type
 *   - Composer: textarea + send + cancel
 *
 * The card has TWO states:
 *   1. LIVE PROCESSING — shows a compact "Working on your request"
 *      timeline of stage ticks + the current action.
 *   2. COMPLETED / FAILED — shows a polished summary card with
 *      action count, elapsed time, privacy count, and an expandable
 *      "View details" section that reveals the raw timeline.
 *
 * Drag is implemented in this module on the header bar (data-rv-drag-handle).
 * Position is persisted via the caller-supplied `onDragEnd(offset)` callback;
 * the caller (content script) is responsible for storage.
 */

import type { AgentActivity } from "../agent/agent-session";

/** Compact summary of what the privacy firewall redacted this turn. */
export interface RedactionSummary {
  /** Total count of sensitive values that were tokenized. */
  count: number;
  /** Per-type counts, e.g. { EMAIL: 1, PHONE: 1, PERSON: 1, PASSWORD: 1 }. */
  byType: Record<string, number>;
  /** True when the firewall is still scanning (used to animate the bar). */
  inProgress?: boolean;
}

export interface ChatUIHandles {
  root: HTMLElement;
  setStatus(state: "ready" | "thinking" | "completed" | "error", label: string): void;
  appendActivity(activity: AgentActivity): void;
  clearConversation(): void;
  setInputEnabled(enabled: boolean): void;
  focusInput(): void;
  setInputValue(v: string): void;
  onSend(handler: (text: string) => void): void;
  onCancel(handler: () => void): void;
  /** Set the visible backend pill in the header (e.g. "Groq", "Server (offline)"). */
  setBackend(label: string): void;
  /** Render the privacy/redaction summary card. */
  setRedactionSummary(summary: RedactionSummary): void;
  /** Collapse the chat card to just the header (or restore it). */
  setMinimized(minimized: boolean): void;
  /** Wire the close button. */
  onClose(handler: () => void): void;
  /** Wire the minimize button. */
  onMinimize(handler: () => void): void;
  /** Wire the drag-end callback. Receives { dx, dy } in CSS pixels. */
  onDragEnd(handler: (offset: { dx: number; dy: number }) => void): void;
  /** Programmatically set the card's drag offset (used to restore persisted position). */
  setDragOffset(dx: number, dy: number): void;
  /** Show the polished end-of-task summary card. */
  showSummary(summary: TaskSummary): void;
  /** Reset the card to a clean state (also hides any prior summary). */
  resetConversation(): void;
  /** Latest sanitized-data snapshot for the details panel. */
  setSanitizedData(data: SanitizedDataSnapshot): void;
  /** Apply dark / light / auto theme to the card. */
  applyTheme(theme: "dark" | "light" | "auto"): void;
  /** Sync the quick-settings auto-redact toggle with stored state. */
  setAutoRedactState(enabled: boolean): void;
  /** Wire the in-card theme toggle (footer moon button / quick settings). */
  onThemeToggle(handler: (next: "dark" | "light") => void): void;
  /** Wire the quick-settings auto-redact toggle. */
  onAutoRedactChange(handler: (enabled: boolean) => void): void;
}

/** Sanitized-data snapshot rendered in the details panel. */
export interface SanitizedDataSnapshot {
  url: string;
  title: string;
  elementCount: number;
  autoRedact: boolean;
  tokens: Array<{ token: string; type: string; masked: string }>;
}

/** Outcome of a single user prompt — drives the summary card. */
export interface TaskSummary {
  phase: "completed" | "failed" | "max_iterations_reached" | "cancelled" | "offline";
  message: string;
  reason: string;
  iterations: number;
  actionsPlanned: number;
  actionsExecuted: number;
  durationMs: number;
  privacy: { count: number; byType: Record<string, number> } | null;
}

export function buildChatUI(container: HTMLElement): ChatUIHandles {
  container.innerHTML = chatHTML();

  const root = container.querySelector(".rv-chat") as HTMLElement;
  const privacyBar = root.querySelector("#rv-privacy-bar") as HTMLElement;
  const headerStatus = root.querySelector("#rv-chat-status") as HTMLElement;
  const statusDot = root.querySelector("#rv-chat-status-dot") as HTMLElement;
  const backendPill = root.querySelector("#rv-backend-pill") as HTMLElement;
  const backendLabel = root.querySelector("#rv-backend-label") as HTMLElement;
  const conversation = root.querySelector("#rv-conversation") as HTMLElement;
  const input = root.querySelector("#rv-input") as HTMLTextAreaElement;
  const sendBtn = root.querySelector("#rv-send-btn") as HTMLButtonElement;
  const cancelBtn = root.querySelector("#rv-cancel-btn") as HTMLButtonElement;
  const minimizeBtn = root.querySelector("#rv-minimize-btn") as HTMLElement;
  const closeBtn = root.querySelector("#rv-close-btn") as HTMLElement;
  const dragHandle = root.querySelector("[data-rv-drag-handle]") as HTMLElement;
  const statusbarDot = root.querySelector("#rv-statusbar-dot") as HTMLElement;
  const statusbarLabel = root.querySelector("#rv-statusbar-label") as HTMLElement;
  const settingsBtn = root.querySelector("#rv-settings-btn") as HTMLElement;
  const themeBtn = root.querySelector("#rv-theme-btn") as HTMLElement;
  const infoBtn = root.querySelector("#rv-info-btn") as HTMLElement;
  const quickSettings = root.querySelector("#rv-quick-settings") as HTMLElement;
  const qsAutoRedact = root.querySelector("#rv-qs-autoredact") as HTMLInputElement;

  let sendHandler: ((text: string) => void) | null = null;
  let cancelHandler: (() => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let minimizeHandler: (() => void) | null = null;
  let dragEndHandler: ((offset: { dx: number; dy: number }) => void) | null = null;

  // ---- Details panel state ----
  let sanitizedData: SanitizedDataSnapshot | null = null;
  let detailsPanel: HTMLElement | null = null;
  let detailsTab: "timeline" | "data" = "timeline";
  let summaryToggleBtn: HTMLButtonElement | null = null;

  // ---- Theme / quick-settings state ----
  let currentTheme: "dark" | "light" = "dark";
  let themeToggleHandler: ((next: "dark" | "light") => void) | null = null;
  let autoRedactHandler: ((enabled: boolean) => void) | null = null;

  // ---- Composer ----

  function submitText(text: string): void {
    const t = text.trim();
    if (!t) return;
    input.value = "";
    input.style.height = "auto";
    sendHandler?.(t);
  }

  sendBtn.addEventListener("click", () => {
    submitText(input.value);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitText(input.value);
    }
  });

  // Auto-grow: the box stays one line tall and only grows when the
  // user writes a longer multi-line task (capped at ~4 lines).
  const autoGrow = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 76) + "px";
  };
  input.addEventListener("input", autoGrow);

  cancelBtn.addEventListener("click", () => {
    cancelHandler?.();
  });

  // Suggestion chips (empty state) — clicking one submits the task.
  conversation.addEventListener("click", (e) => {
    const chip = (e.target as HTMLElement).closest?.(
      ".rv-chip-suggest"
    ) as HTMLElement | null;
    if (chip?.dataset.suggest) {
      submitText(chip.dataset.suggest);
    }
  });

  // ---- Header buttons ----

  minimizeBtn.addEventListener("click", () => {
    minimizeHandler?.();
  });

  closeBtn.addEventListener("click", () => {
    closeHandler?.();
  });

  // ---- Drag (pointer events) ----
  //
  // The widget's "natural" position is bottom-right (CSS). The caller
  // supplies a stored offset via setDragOffset() on mount, and we update
  // the offset live during drag, firing onDragEnd() on release.

  let dragStart: { pointerX: number; pointerY: number; baseX: number; baseY: number } | null = null;

  const applyOffset = (dx: number, dy: number) => {
    // Clamp the card to the viewport so it can't be dragged offscreen.
    const maxX = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - root.offsetHeight);
    const cdx = Math.max(-maxX, Math.min(dx, 0));
    const cdy = Math.max(-maxY, Math.min(dy, 0));
    root.style.setProperty("--rv-drag-x", `${cdx}px`);
    root.style.setProperty("--rv-drag-y", `${cdy}px`);
  };

  dragHandle.addEventListener("pointerdown", (e) => {
    // Ignore drags that started on the header buttons (they handle their
    // own clicks). The buttons are not inside the drag handle, but be safe.
    if ((e.target as HTMLElement).closest("button")) return;
    if (e.button !== 0) return;

    e.preventDefault();
    dragHandle.setPointerCapture(e.pointerId);
    const rect = root.getBoundingClientRect();
    // CSS positions the card via bottom/right. Compute the current
    // offset from the natural bottom-right anchor.
    const naturalLeft = window.innerWidth - rect.right;
    const naturalTop = window.innerHeight - rect.bottom;
    dragStart = {
      pointerX: e.clientX,
      pointerY: e.clientY,
      baseX: -naturalLeft, // convert anchor to "x offset from natural"
      baseY: -naturalTop,
    };
  });

  dragHandle.addEventListener("pointermove", (e) => {
    if (!dragStart) return;
    const dx = dragStart.baseX + (e.clientX - dragStart.pointerX);
    const dy = dragStart.baseY + (e.clientY - dragStart.pointerY);
    applyOffset(dx, dy);
  });

  const endDrag = (e: PointerEvent) => {
    if (!dragStart) return;
    try {
      dragHandle.releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    // Read the final offset back from the live style.
    const fx = parseFloat(root.style.getPropertyValue("--rv-drag-x") || "0");
    const fy = parseFloat(root.style.getPropertyValue("--rv-drag-y") || "0");
    dragEndHandler?.({ dx: fx, dy: fy });
    dragStart = null;
  };

  dragHandle.addEventListener("pointerup", endDrag);
  dragHandle.addEventListener("pointercancel", endDrag);

  // ---- Live processing view ----
  //
  // A compact, single-purpose block that appears immediately after
  // the user sends a prompt. It shows the steps the agent has
  // already completed, the current step, and an elapsed-time chip.
  // The processing block is REPLACED by a polished summary card
  // when the agent finishes.

  type Step = { key: string; label: string; done: boolean; active: boolean };
  let currentProcessing: {
    el: HTMLElement;
    stepsEl: HTMLElement;
    currentEl: HTMLElement;
    elapsedEl: HTMLElement;
    startedAt: number;
    steps: Step[];
    timer: ReturnType<typeof setInterval> | null;
  } | null = null;

  const DEFAULT_STEPS: Step[] = [
    { key: "perceive", label: "Page analyzed", done: false, active: false },
    { key: "privacy", label: "Privacy protected", done: false, active: false },
    { key: "context", label: "Context prepared", done: false, active: false },
    { key: "plan", label: "Agent planned", done: false, active: false },
    { key: "execute", label: "Action executed", done: false, active: false },
  ];

  function startProcessing(): void {
    // First clear the empty placeholder.
    const placeholder = conversation.querySelector(".rv-empty");
    if (placeholder) placeholder.remove();

    // Tear down any prior processing block.
    if (currentProcessing) endProcessing("completed", "");

    const startedAt = Date.now();
    const el = document.createElement("div");
    el.className = "rv-processing";
    el.innerHTML = `
      <div class="rv-processing-header">
        <div class="rv-processing-spinner"></div>
        <span>Working on your request</span>
        <span class="rv-processing-elapsed">0.0s</span>
      </div>
      <div class="rv-processing-current" data-processing-current>Planning next step…</div>
      <div class="rv-processing-steps"></div>
    `;
    conversation.appendChild(el);
    const stepsEl = el.querySelector(".rv-processing-steps") as HTMLElement;
    const currentEl = el.querySelector("[data-processing-current]") as HTMLElement;
    const elapsedEl = el.querySelector(".rv-processing-elapsed") as HTMLElement;

    // Seed steps.
    const steps: Step[] = DEFAULT_STEPS.map((s) => ({ ...s }));
    function renderSteps() {
      stepsEl.innerHTML = steps
        .map(
          (s) => `
        <div class="rv-processing-step ${s.done ? "rv-done" : ""} ${s.active ? "rv-active" : ""}">
          <span class="rv-step-icon">${s.done ? "✓" : s.active ? "◌" : "·"}</span>
          <span>${escapeHtml(s.label)}</span>
        </div>`
        )
        .join("");
    }
    renderSteps();

    const timer = setInterval(() => {
      const s = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (elapsedEl) elapsedEl.textContent = `${s}s`;
    }, 100);

    currentProcessing = { el, stepsEl, currentEl, elapsedEl, startedAt, steps, timer };
    conversation.scrollTop = conversation.scrollHeight;
  }

  function updateProcessingStep(key: string, currentAction?: string): void {
    if (!currentProcessing) return;
    const cp = currentProcessing;
    // Mark earlier steps as done; mark the matching step active.
    let foundActive = false;
    cp.steps = cp.steps.map((s) => {
      if (foundActive) return s;
      if (s.key === key) {
        foundActive = true;
        return { ...s, done: false, active: true };
      }
      return s.done ? s : { ...s, done: true, active: false };
    });
    function render() {
      cp.stepsEl.innerHTML = cp.steps
        .map(
          (s) => `
        <div class="rv-processing-step ${s.done ? "rv-done" : ""} ${s.active ? "rv-active" : ""}">
          <span class="rv-step-icon">${s.done ? "✓" : s.active ? "◌" : "·"}</span>
          <span>${escapeHtml(s.label)}</span>
        </div>`
        )
        .join("");
    }
    render();
    if (currentAction && cp.currentEl) {
      cp.currentEl.textContent = currentAction;
    }
    conversation.scrollTop = conversation.scrollHeight;
  }

  function endProcessing(_phase: string, _finalMessage: string): void {
    if (!currentProcessing) return;
    const cp = currentProcessing;
    if (cp.timer) clearInterval(cp.timer);
    // Animate out: collapse to a single "done" line, then remove.
    cp.el.style.transition = "opacity 0.18s ease, max-height 0.25s ease, margin 0.25s ease";
    cp.el.style.maxHeight = cp.el.offsetHeight + "px";
    requestAnimationFrame(() => {
      cp.el.style.opacity = "0";
      cp.el.style.maxHeight = "0";
      cp.el.style.margin = "0 14px";
      cp.el.style.padding = "0 14px";
      cp.el.style.overflow = "hidden";
      setTimeout(() => cp.el.remove(), 280);
    });
    currentProcessing = null;
  }

  // ---- Activity rendering ----
  //
  // Thought activities are streamed in to the live processing view.
  // Final activities (action_planned, action_validated, action_executed,
  // action_rejected, error, iteration_complete, info) are recorded in
  // a hidden timeline that backs the expandable "View details" panel
  // of the summary card.

  let detailedTimeline: AgentActivity[] = [];

  function recordActivity(activity: AgentActivity): void {
    detailedTimeline.push(activity);
  }

  function mapStageToProcessing(activity: AgentActivity): { key: string; current?: string } | null {
    if (activity.kind === "llm_thinking") {
      return { key: "plan", current: activity.text || "Agent reasoning…" };
    }
    if (activity.kind === "stage") {
      const t = (activity.text || "").toLowerCase();
      const d = (activity.detail || "").toLowerCase();
      if (t.includes("analyzing") || t.includes("understanding") || d.includes("dom")) {
        return { key: "perceive" };
      }
      if (t.includes("privacy") || t.includes("firewall") || t.includes("protect")) {
        return { key: "privacy" };
      }
      if (t.includes("sanitized") || t.includes("context") || t.includes("preparing")) {
        return { key: "context" };
      }
      if (t.includes("validating") || t.includes("validation")) {
        return { key: "plan" };
      }
      if (t.includes("executing") || t.includes("execution") || t.includes("observation") || t.includes("verification") || t.includes("re-evaluating")) {
        return { key: "execute" };
      }
    }
    if (activity.kind === "action_planned") {
      return { key: "plan", current: activity.text };
    }
    if (activity.kind === "action_validated") {
      return { key: "plan", current: activity.text };
    }
    if (activity.kind === "action_executed") {
      return { key: "execute", current: activity.text };
    }
    return null;
  }

  function renderActivity(activity: AgentActivity): void {
    recordActivity(activity);

    // Update the live processing view (if active).
    if (currentProcessing) {
      const m = mapStageToProcessing(activity);
      if (m) {
        updateProcessingStep(m.key, m.current);
      }
    }

    // Thought activities (stage / llm_thinking) are intentionally
    // NOT streamed as a raw timeline — they live in the live
    // processing view. Final activities that signal an outcome
    // are rendered into a compact hidden timeline for "View details".
    if (activity.kind === "stage" || activity.kind === "llm_thinking") {
      return;
    }

    // Skip duplicate user echo (already shown when send was pressed).
    if (activity.kind === "user") {
      // No-op: we already appended the bubble in clearConversation->onSend.
      return;
    }

    // Otherwise: append a small marker to the conversation so the
    // timeline is not completely empty when "View details" is
    // expanded. Real users will rely on the live processing view
    // and the summary card; this just keeps the raw log coherent.
    const block = document.createElement("div");
    block.className = `rv-msg rv-${activity.kind}`;
    block.dataset.id = activity.id;
    block.innerHTML = `
      <div class="rv-msg-icon">${iconFor(activity.kind)}</div>
      <div class="rv-msg-body">
        <div class="rv-msg-text">${escapeHtml(activity.text)}</div>
        ${activity.detail ? `<div class="rv-msg-detail">${escapeHtml(activity.detail)}</div>` : ""}
      </div>
    `;
    // We DO render these inline so the "View details" panel can
    // simply be a scroll-to-bottom of the conversation. The user
    // sees a clean live processing card on top, and the timeline
    // is hidden behind the "View details" toggle in the summary.
    conversation.appendChild(block);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function appendUserBubble(text: string): void {
    const placeholder = conversation.querySelector(".rv-empty");
    if (placeholder) placeholder.remove();
    const block = document.createElement("div");
    block.className = "rv-msg rv-user";
    block.innerHTML = `<div class="rv-msg-bubble">${escapeHtml(text)}</div>`;
    conversation.appendChild(block);
    conversation.scrollTop = conversation.scrollHeight;
  }

  // ---- Status & backend pill ----

  function setStatus(
    state: "ready" | "thinking" | "completed" | "error",
    label: string
  ): void {
    statusDot.className = `rv-chat-dot rv-${state}`;
    headerStatus.textContent = label;
    // Mirror the status into the footer statusbar pill.
    if (statusbarDot && statusbarLabel) {
      statusbarDot.className = `rv-statusbar-dot rv-${state}`;
      statusbarLabel.textContent = label;
    }
    if (state === "thinking") {
      privacyBar.classList.add("rv-active");
    } else {
      privacyBar.classList.remove("rv-active");
    }
  }

  function setBackend(label: string): void {
    if (!backendPill || !backendLabel) return;
    backendLabel.textContent = label;
    // Pick a pill variant from the label
    const lower = label.toLowerCase();
    let variant = "rv-server";
    if (lower.includes("groq")) variant = "rv-groq";
    else if (lower.includes("gemini")) variant = "rv-gemini";
    else if (lower.includes("openrouter")) variant = "rv-openrouter";
    else if (lower.includes("nvidia")) variant = "rv-nvidia";
    else if (lower.includes("omni")) variant = "rv-omni";
    else if (lower.includes("hugging") || lower.includes("hf")) variant = "rv-hf";
    else if (lower.includes("offline") || lower.includes("local")) variant = "rv-offline";
    backendPill.className = `rv-backend-pill ${variant}`;
  }

  function setRedactionSummary(summary: RedactionSummary): void {
    // Find the existing redaction card (if any) or create one.
    let card = root.querySelector(".rv-redaction-card") as HTMLElement | null;
    if (!card) {
      card = document.createElement("div");
      card.className = "rv-redaction-card";
      conversation.appendChild(card);
    }

    const types = Object.keys(summary.byType);
    const pills = types
      .map((t) => {
        const count = summary.byType[t];
        const icon = iconForType(t);
        return `<span class="rv-redaction-pill" data-type="${escapeAttr(t)}">
                  <span class="rv-redaction-icon">${icon}</span>
                  <span class="rv-redaction-type">[${escapeHtml(t)}_…]</span>
                  <span class="rv-redaction-count">${count}</span>
                </span>`;
      })
      .join("");

    card.innerHTML = `
      <div class="rv-redaction-header">
        <span class="rv-redaction-shield">🛡</span>
        <span class="rv-redaction-title">Privacy firewall</span>
        <span class="rv-redaction-state ${summary.inProgress ? "rv-busy" : "rv-idle"}">
          ${summary.inProgress ? "Sanitizing…" : "Sanitized"}
        </span>
      </div>
      <div class="rv-redaction-body">
        <div class="rv-redaction-pills">${pills || '<span class="rv-redaction-empty">no sensitive values on this page</span>'}</div>
        <div class="rv-redaction-foot">
          <span class="rv-redaction-count-total">${summary.count} sensitive value${summary.count === 1 ? "" : "s"} protected locally</span>
          <span class="rv-redaction-safety ${summary.count > 0 ? "rv-safe" : "rv-neutral"}">
            ${summary.count > 0 ? "● Server payload: safe" : "○ Nothing to redact"}
          </span>
        </div>
      </div>
    `;

    if (summary.inProgress) {
      privacyBar.classList.add("rv-active");
    } else if (!statusDot.classList.contains("rv-thinking")) {
      privacyBar.classList.remove("rv-active");
    }
  }

  function showSummary(summary: TaskSummary): void {
    // Replace live processing (if still up) with the summary card.
    endProcessing(summary.phase, summary.message);

    // Build the summary card.
    const isOk = summary.phase === "completed";
    const isFailed = summary.phase === "failed";
    const isCapped = summary.phase === "max_iterations_reached";
    const isOffline = summary.phase === "offline";
    const variantClass = isFailed || isOffline
      ? "rv-summary-failed"
      : isCapped
      ? "rv-summary-capped"
      : "";
    const iconChar = isOk ? "✓" : isFailed || isOffline ? "✕" : isCapped ? "!" : "·";
    const title = isOk
      ? "Task completed"
      : isOffline
      ? "Server agent offline"
      : isFailed
      ? "Task could not be completed"
      : isCapped
      ? "Agent stopped"
      : "Cancelled";

    // Build a brief human-readable message.
    let message: string;
    if (isOk) {
      message =
        summary.actionsExecuted === 1
          ? "Your request was completed in a single action."
          : `Completed using ${summary.actionsExecuted} action${summary.actionsExecuted === 1 ? "" : "s"}.`;
    } else if (isCapped) {
      message = "The agent could not determine a successful completion within the safety limit.";
    } else if (isOffline) {
      message =
        summary.reason ||
        "The server-side LLM agent is currently unavailable. Check that the server is running and has at least one provider configured.";
    } else if (isFailed) {
      message = summary.reason || "The agent was unable to complete the task.";
    } else {
      message = "Cancelled by user.";
    }

    // Privacy count for the stats row.
    const privacyCount = summary.privacy?.count ?? 0;
    const privacyByType = summary.privacy?.byType ?? {};
    const privacySummary = privacyCount > 0
      ? `${privacyCount} sensitive item${privacyCount === 1 ? "" : "s"} protected locally`
      : "No sensitive items on this page";

    // Compose the stats chips.
    const elapsed = (summary.durationMs / 1000).toFixed(1) + "s";
    const stats: Array<{ icon: string; label: string; value: string }> = [];
    if (summary.actionsExecuted > 0) {
      stats.push({
        icon: "⚡",
        label: "actions",
        value: String(summary.actionsExecuted),
      });
    }
    stats.push({ icon: "⏱", label: "elapsed", value: elapsed });
    stats.push({ icon: "🛡", label: "privacy", value: privacySummary });

    const statsHtml = stats
      .map(
        (s) => `<span class="rv-summary-stat">
                  <span class="rv-summary-stat-icon">${escapeHtml(s.icon)}</span>
                  <span class="rv-summary-stat-label">${escapeHtml(s.label)}</span>
                  <span>${escapeHtml(s.value)}</span>
                </span>`
      )
      .join("");

    const card = document.createElement("div");
    card.className = `rv-summary ${variantClass}`;
    card.innerHTML = `
      <div class="rv-summary-head">
        <div class="rv-summary-icon">${iconChar}</div>
        <div>
          <div class="rv-summary-title">${escapeHtml(title)}</div>
          <div class="rv-summary-message">${escapeHtml(message)}</div>
        </div>
      </div>
      <div class="rv-summary-stats">${statsHtml}</div>
      <button type="button" class="rv-summary-toggle" data-summary-toggle>View details</button>
    `;

    // Insert the summary card right after the redaction card (if any)
    // so privacy info stays visible above the result.
    const redaction = conversation.querySelector(".rv-redaction-card");
    if (redaction && redaction.nextSibling) {
      conversation.insertBefore(card, redaction.nextSibling);
    } else {
      conversation.appendChild(card);
    }

    // Wire the "View details" toggle to open the full-screen details
    // panel (timeline + sanitized data) inside the card.
    const toggle = card.querySelector("[data-summary-toggle]") as HTMLButtonElement;
    summaryToggleBtn = toggle;
    toggle.addEventListener("click", () => {
      const isOpen = detailsPanel?.classList.contains("rv-open");
      if (isOpen) {
        closeDetails();
      } else {
        openDetails("timeline");
      }
    });

    conversation.scrollTop = conversation.scrollHeight;
  }

  // ---- Details panel (Timeline + Sanitized data) ----

  function openDetails(tab: "timeline" | "data"): void {
    detailsTab = tab;
    if (!detailsPanel) {
      detailsPanel = document.createElement("div");
      detailsPanel.className = "rv-details-panel";
      root.appendChild(detailsPanel);
    }
    renderDetails();
    detailsPanel.classList.add("rv-open");
    if (summaryToggleBtn) {
      summaryToggleBtn.classList.add("rv-summary-toggle-open");
      summaryToggleBtn.textContent = "Hide details";
    }
  }

  function closeDetails(): void {
    detailsPanel?.classList.remove("rv-open");
    if (summaryToggleBtn) {
      summaryToggleBtn.classList.remove("rv-summary-toggle-open");
      summaryToggleBtn.textContent = "View details";
    }
  }

  function renderDetails(): void {
    if (!detailsPanel) return;

    const tabsHtml = `
      <div class="rv-details-tabs">
        <button type="button" class="rv-details-tab ${detailsTab === "timeline" ? "rv-active" : ""}" data-tab="timeline">
          Timeline
        </button>
        <button type="button" class="rv-details-tab ${detailsTab === "data" ? "rv-active" : ""}" data-tab="data">
          Sanitized data
        </button>
        <button type="button" class="rv-details-close" data-details-close aria-label="Close details">×</button>
      </div>
    `;

    let bodyHtml = "";
    if (detailsTab === "timeline") {
      if (detailedTimeline.length === 0) {
        bodyHtml = `<div class="rv-details-empty">No activity yet — send a prompt first.</div>`;
      } else {
        bodyHtml = `<div class="rv-details-timeline">${detailedTimeline
          .map((a) => {
            const time = new Date(a.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
            return `
              <div class="rv-details-item rv-dt-${a.kind}">
                <div class="rv-details-item-icon">${iconFor(a.kind)}</div>
                <div class="rv-details-item-body">
                  <div class="rv-details-item-text">${escapeHtml(a.text)}</div>
                  ${a.detail ? `<div class="rv-details-item-detail">${escapeHtml(a.detail)}</div>` : ""}
                </div>
                <div class="rv-details-item-time">${time}</div>
              </div>
            `;
          })
          .join("")}</div>`;
      }
    } else {
      if (!sanitizedData) {
        bodyHtml = `<div class="rv-details-empty">Send a prompt first — the sanitized snapshot is captured during the agent loop.</div>`;
      } else {
        const tokenRows = sanitizedData.tokens.length
          ? sanitizedData.tokens
              .map(
                (t) => `
              <div class="rv-token-row">
                <span class="rv-token-icon">${iconForType(t.type)}</span>
                <span class="rv-token-name">${escapeHtml(t.token)}</span>
                <span class="rv-token-type">${escapeHtml(t.type)}</span>
                <span class="rv-token-masked">${escapeHtml(t.masked)}</span>
              </div>
            `
              )
              .join("")
          : `<div class="rv-details-empty">No sensitive values were detected on this page.</div>`;

        bodyHtml = `
          <div class="rv-data-summary">
            <div class="rv-data-row"><span>Page</span><span>${escapeHtml(sanitizedData.title || sanitizedData.url || "—")}</span></div>
            <div class="rv-data-row"><span>Elements sent to server</span><span>${sanitizedData.elementCount}</span></div>
            <div class="rv-data-row"><span>Tokens created</span><span>${sanitizedData.tokens.length}</span></div>
            <div class="rv-data-row ${sanitizedData.autoRedact ? "rv-ok" : "rv-bad"}">
              <span>Auto-redact</span><span>${sanitizedData.autoRedact ? "● ON — PII protected" : "⚠ OFF — raw PII may leave the device"}</span>
            </div>
          </div>
          <div class="rv-token-table">${tokenRows}</div>
          <div class="rv-data-note">Masked values are shown only here, locally. The server never sees the original values — only tokens like <code>[EMAIL_01]</code>.</div>
        `;
      }
    }

    detailsPanel.innerHTML = `${tabsHtml}<div class="rv-details-body">${bodyHtml}</div>`;

    detailsPanel.querySelectorAll<HTMLButtonElement>(".rv-details-tab").forEach((b) => {
      b.addEventListener("click", () => openDetails(b.dataset.tab as "timeline" | "data"));
    });
    detailsPanel.querySelector("[data-details-close]")?.addEventListener("click", closeDetails);
  }

  function setInputEnabled(enabled: boolean): void {
    input.disabled = !enabled;
    sendBtn.disabled = !enabled;
    // Cancel is active while the agent is working, disabled when idle.
    cancelBtn.disabled = enabled;
    if (enabled) input.focus();
  }

  function focusInput(): void {
    input.focus();
  }

  function setInputValue(v: string): void {
    input.value = v;
  }

  function setMinimized(minimized: boolean): void {
    root.classList.toggle("rv-minimized", minimized);
  }

  function setDragOffset(dx: number, dy: number): void {
    applyOffset(dx, dy);
  }

  function setSanitizedData(data: SanitizedDataSnapshot): void {
    sanitizedData = data;
    // Live-refresh the panel if it is open on the data tab.
    if (detailsPanel?.classList.contains("rv-open") && detailsTab === "data") {
      renderDetails();
    }
  }

  function applyTheme(theme: "dark" | "light" | "auto"): void {
    const light =
      theme === "light" ||
      (theme === "auto" && window.matchMedia("(prefers-color-scheme: light)").matches);
    currentTheme = light ? "light" : "dark";
    root.classList.toggle("rv-light", light);
    themeBtn.textContent = light ? "☀️" : "🌙";
    quickSettings
      .querySelectorAll<HTMLButtonElement>("[data-qs-theme]")
      .forEach((b) =>
        b.classList.toggle("rv-active", b.dataset.qsTheme === currentTheme)
      );
  }

  function setAutoRedactState(enabled: boolean): void {
    qsAutoRedact.checked = enabled;
  }

  // ---- Footer / quick settings wiring ----

  themeBtn.addEventListener("click", () => {
    themeToggleHandler?.(currentTheme === "dark" ? "light" : "dark");
  });

  settingsBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    quickSettings.classList.toggle("rv-open");
  });

  infoBtn.addEventListener("click", () => {
    const isOpen = detailsPanel?.classList.contains("rv-open");
    if (isOpen) {
      closeDetails();
    } else {
      openDetails("timeline");
    }
  });

  quickSettings.querySelectorAll<HTMLButtonElement>("[data-qs-theme]").forEach((b) => {
    b.addEventListener("click", () => {
      themeToggleHandler?.(b.dataset.qsTheme as "dark" | "light");
    });
  });

  qsAutoRedact.addEventListener("change", () => {
    autoRedactHandler?.(qsAutoRedact.checked);
  });

  // Close the quick-settings popover when clicking anywhere else in the card.
  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (
      quickSettings.classList.contains("rv-open") &&
      !quickSettings.contains(target) &&
      !settingsBtn.contains(target)
    ) {
      quickSettings.classList.remove("rv-open");
    }
  });

  function clearConversation(): void {
    // Tear down the live processing block (if any).
    if (currentProcessing) {
      if (currentProcessing.timer) clearInterval(currentProcessing.timer);
      currentProcessing.el.remove();
      currentProcessing = null;
    }
    detailedTimeline = [];
    conversation.innerHTML = emptyStateHTML();
  }

  function resetConversation(): void {
    clearConversation();
  }

  // ---- Public wiring ----

  function onSend(handler: (text: string) => void): void {
    sendHandler = (text: string) => {
      // 1) Show the user bubble immediately (low-latency feedback).
      appendUserBubble(text);
      // 2) Start the live processing view.
      startProcessing();
      // 3) Hand off to the caller.
      handler(text);
    };
  }
  function onCancel(handler: () => void): void {
    cancelHandler = handler;
  }
  function onClose(handler: () => void): void {
    closeHandler = handler;
  }
  function onMinimize(handler: () => void): void {
    minimizeHandler = handler;
  }
  function onDragEnd(handler: (offset: { dx: number; dy: number }) => void): void {
    dragEndHandler = handler;
  }

  return {
    root,
    setStatus,
    appendActivity: renderActivity,
    clearConversation,
    setInputEnabled,
    focusInput,
    setInputValue,
    onSend,
    onCancel,
    setBackend,
    setRedactionSummary,
    setMinimized,
    onClose,
    onMinimize,
    onDragEnd,
    setDragOffset,
    showSummary,
    resetConversation,
    setSanitizedData,
    applyTheme,
    setAutoRedactState,
    onThemeToggle(handler: (next: "dark" | "light") => void): void {
      themeToggleHandler = handler;
    },
    onAutoRedactChange(handler: (enabled: boolean) => void): void {
      autoRedactHandler = handler;
    },
  };
}

function chatHTML(): string {
  return `
    <div class="rv-chat" data-rv-card>
      <div class="rv-privacy-bar" id="rv-privacy-bar" data-rv-drag-handle></div>

      <header class="rv-chat-header" data-rv-drag-handle>
        <div class="rv-chat-brand">
          <div class="rv-chat-avatar">RV</div>
          <div class="rv-chat-brand-text">
            <div class="rv-chat-title">RedactVision Agent</div>
            <div class="rv-chat-status-row">
              <span id="rv-chat-status-dot" class="rv-chat-dot rv-ready"></span>
              <span id="rv-chat-status">Ready</span>
            </div>
          </div>
        </div>
        <div class="rv-backend-pill rv-server" id="rv-backend-pill" title="Active reasoning backend">
          <span class="rv-backend-icon">▤</span>
          <span id="rv-backend-label">Server</span>
        </div>
        <div class="rv-chat-controls">
          <button class="rv-icon-btn" id="rv-minimize-btn" type="button" title="Minimize" aria-label="Minimize">−</button>
          <button class="rv-icon-btn rv-close" id="rv-close-btn" type="button" title="Close" aria-label="Close">×</button>
        </div>
      </header>

      <main class="rv-conversation" id="rv-conversation">${emptyStateHTML()}</main>

      <footer class="rv-composer">
        <div class="rv-input-wrap">
          <textarea
            id="rv-input"
            class="rv-input"
            rows="1"
            placeholder="Type a task…  (Enter to send)"
          ></textarea>
          <div class="rv-composer-row">
            <button class="rv-attach-btn" id="rv-attach-btn" type="button" title="Attachments coming soon" disabled>📎</button>
            <button class="rv-cancel-btn" id="rv-cancel-btn" type="button" disabled>Cancel</button>
            <button class="rv-send-btn" id="rv-send-btn" type="button" aria-label="Send">
              <span class="rv-send-icon">➤</span>
            </button>
          </div>
        </div>
      </footer>

      <footer class="rv-statusbar">
        <div class="rv-statusbar-brand">
          <span class="rv-statusbar-avatar">RV</span>
          <span class="rv-statusbar-name">RedactVision</span>
          <span class="rv-statusbar-pill">
            <span class="rv-statusbar-dot rv-ready" id="rv-statusbar-dot"></span>
            <span id="rv-statusbar-label">Ready</span>
          </span>
        </div>
        <div class="rv-statusbar-actions">
          <button class="rv-sb-btn" id="rv-settings-btn" type="button" title="Quick settings" aria-label="Quick settings">⚙️</button>
          <button class="rv-sb-btn" id="rv-theme-btn" type="button" title="Toggle theme" aria-label="Toggle theme">🌙</button>
          <button class="rv-sb-btn" id="rv-info-btn" type="button" title="Details & sanitized data" aria-label="Details">ⓘ</button>
        </div>
      </footer>

      <div class="rv-quick-settings" id="rv-quick-settings">
        <div class="rv-qs-title">Quick settings</div>
        <div class="rv-qs-row">
          <span class="rv-qs-label">Theme</span>
          <div class="rv-qs-seg">
            <button type="button" data-qs-theme="dark">Dark</button>
            <button type="button" data-qs-theme="light">Light</button>
          </div>
        </div>
        <label class="rv-qs-row rv-qs-toggle-row">
          <span class="rv-qs-label">Auto-redact PII</span>
          <input type="checkbox" id="rv-qs-autoredact" checked />
          <span class="rv-qs-switch"><span class="rv-qs-switch-thumb"></span></span>
        </label>
      </div>
    </div>
  `;
}

function emptyStateHTML(): string {
  return `
    <div class="rv-empty">
      <div class="rv-empty-bot">🤖</div>
      <div class="rv-empty-title">Ready when you are</div>
      <div class="rv-empty-try">Try:</div>
      <div class="rv-empty-chips">
        <button type="button" class="rv-chip-suggest" data-suggest="scroll down">
          <span class="rv-chip-ic">↓</span> scroll down
        </button>
        <span class="rv-chip-sep">·</span>
        <button type="button" class="rv-chip-suggest" data-suggest="click submit">
          <span class="rv-chip-ic">↖</span> click submit
        </button>
        <span class="rv-chip-sep">·</span>
        <button type="button" class="rv-chip-suggest" data-suggest="fill the email">
          <span class="rv-chip-ic">✎</span> fill the email
        </button>
      </div>
    </div>
  `;
}

function iconFor(kind: AgentActivity["kind"]): string {
  switch (kind) {
    case "user":
      return "👤";
    case "stage":
      return "◌";
    case "llm_thinking":
      return "🧠";
    case "action_planned":
      return "⚡";
    case "action_validated":
      return "✓";
    case "action_executed":
      return "✅";
    case "action_rejected":
      return "✗";
    case "iteration_complete":
      return "🏁";
    case "error":
      return "⚠️";
    case "info":
      return "ℹ";
    default:
      return "·";
  }
}

function iconForType(type: string): string {
  const t = type.toUpperCase();
  if (t.includes("EMAIL")) return "📧";
  if (t.includes("PHONE")) return "📱";
  if (t.includes("PASSWORD") || t.includes("PASS")) return "🔒";
  if (t.includes("PERSON") || t.includes("NAME")) return "👤";
  if (t.includes("CARD") || t.includes("CC")) return "💳";
  if (t.includes("ADDRESS")) return "🏠";
  return "🛡";
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s);
}

/* ---- Logo helpers (used by content script for the launcher pill) ---- */

/** Returns the extension's logo URL from the icons/ folder. */
export function rvLogoUrl(): string {
  return chrome.runtime.getURL("icons/logo.png");
}

/**
 * CSP-safe upgrade: if the browser can handle SVG, swap the `<img>` src
 * to an inline SVG data-URL so it scales cleanly. Falls back to the
 * supplied `fallback` (the PNG) when SVG rendering isn't possible.
 */
export async function upgradeLogoUrl(
  img: HTMLImageElement,
  fallback: string
): Promise<void> {
  try {
    const resp = await fetch(chrome.runtime.getURL("icons/logo.svg"));
    if (!resp.ok) return; // no SVG — stick with PNG
    const svg = await resp.text();
    const blob = new Blob([svg], { type: "image/svg+xml" });
    img.src = URL.createObjectURL(blob);
  } catch {
    // SVG not available — keep the PNG fallback
    img.src = fallback;
  }
}
