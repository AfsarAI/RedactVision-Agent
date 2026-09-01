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

/* ======================================================================
 * Brand logo (src/ui/SIH.jpeg → icons/logo.png)
 * Replaces the old "RV" text placeholder in the chat header avatar and
 * footer statusbar. Two hardening measures so the logo always renders:
 *   1. blob-URL upgrade — some host pages have a strict CSP that blocks
 *      chrome-extension:// images; fetch + blob URLs pass most CSPs.
 *   2. inline-SVG fallback — if neither image path loads, the avatar
 *      degrades to a gradient "RV" badge instead of a blank square.
 * ====================================================================== */

const RV_LOGO_CHROME_URL =
  typeof chrome !== "undefined" && chrome.runtime?.getURL
    ? chrome.runtime.getURL("icons/logo.png")
    : "";

const RV_LOGO_FALLBACK_SVG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#5b6bff"/>
          <stop offset="1" stop-color="#22d3a0"/>
        </linearGradient>
      </defs>
      <rect width="64" height="64" rx="14" fill="url(#g)"/>
      <text x="32" y="42" text-anchor="middle" font-family="-apple-system,Arial,sans-serif" font-size="24" font-weight="700" fill="white">RV</text>
    </svg>`
  );

/** Resolve the logo image URL (chrome extension, or inline SVG fallback). */
export function rvLogoUrl(): string {
  return RV_LOGO_CHROME_URL || RV_LOGO_FALLBACK_SVG;
}

/**
 * Upgrade an <img> to a blob: URL so strict host-page CSPs cannot block
 * the chrome-extension:// resource. Keeps the original URL on failure.
 */
export async function upgradeLogoUrl(
  img: HTMLImageElement,
  chromeUrl: string
): Promise<void> {
  if (!chromeUrl) return;
  try {
    const resp = await fetch(chromeUrl);
    if (!resp.ok) return;
    const blob = await resp.blob();
    img.src = URL.createObjectURL(blob);
  } catch {
    /* keep the chrome-extension:// URL — works on most pages */
  }
}

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
  /** Show a validation error card (orange/yellow warning) with retry button. */
  showValidationError(error: ValidationError): void;
  /** Show a system error card (extension context, server offline) with action button. */
  showSystemError(error: SystemError): void;
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

/** Validation error details for client-side form validation. */
export interface ValidationError {
  field: string;
  userValue: string;
  issue: string;
  expected: string;
}

/** System error details (extension context, server offline, etc.) */
export interface SystemError {
  type: "extension_context_invalidated" | "server_unreachable" | "runtime_error";
  title: string;
  message: string;
  actionLabel: string;
  actionType: "refresh" | "retry";
}

export function buildChatUI(container: HTMLElement): ChatUIHandles {
  container.innerHTML = chatHTML();

  const root = container.querySelector<HTMLElement>(".rv-chat");
  if (!root) {
    console.error("[RedactVision] ChatUI: Root element .rv-chat not found");
    throw new Error("Failed to initialize chat UI: root element not found");
  }

  // Brand logo imgs (header avatar + statusbar avatar): wire the
  // CSP-safe blob upgrade and the inline-SVG error fallback.
  const avatarImgs = root.querySelectorAll<HTMLImageElement>("img[data-rv-logo]");
  avatarImgs.forEach((img) => {
    img.addEventListener("error", () => {
      if (img.src !== RV_LOGO_FALLBACK_SVG) img.src = RV_LOGO_FALLBACK_SVG;
    });
    void upgradeLogoUrl(img, RV_LOGO_CHROME_URL);
  });

  // All DOM elements are nullable - accessors must check before use
  const privacyBar = root.querySelector<HTMLElement>("#rv-privacy-bar");
  const headerStatus = root.querySelector<HTMLElement>("#rv-chat-status");
  const statusDot = root.querySelector<HTMLElement>("#rv-chat-status-dot");
  const backendPill = root.querySelector<HTMLElement>("#rv-backend-pill");
  const backendLabel = root.querySelector<HTMLElement>("#rv-backend-label");
  const conversation = root.querySelector<HTMLElement>("#rv-conversation");
  const input = root.querySelector<HTMLTextAreaElement>("#rv-input");
  const sendBtn = root.querySelector<HTMLButtonElement>("#rv-send-btn");
  const minimizeBtn = root.querySelector<HTMLElement>("#rv-minimize-btn");
  const closeBtn = root.querySelector<HTMLElement>("#rv-close-btn");
  const dragHandle = root.querySelector<HTMLElement>("[data-rv-drag-handle]");
  const menuBtn = root.querySelector<HTMLElement>("#rv-menu-btn");
  const menuDropdown = root.querySelector<HTMLElement>("#rv-menu");
  const menuThemeIcon = root.querySelector<HTMLElement>("#rv-menu-theme-icon");
  const suggestRow = root.querySelector<HTMLElement>("#rv-suggest-row");
  const quickSettings = root.querySelector<HTMLElement>("#rv-quick-settings");
  const qsAutoRedact = root.querySelector<HTMLInputElement>("#rv-qs-autoredact");

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

  // Latest redaction summary — feeds the working-line privacy detail.
  let lastRedactionSummary: RedactionSummary | null = null;

  // ---- Composer ----

  // Send ↔ Stop mode. While the agent is running, the single circular
  // button on the right becomes a stop button wired to cancelHandler.
  let isProcessing = false;

  function setSendMode(stop: boolean): void {
    isProcessing = stop;
    if (sendBtn) {
      sendBtn.classList.toggle("rv-stop", stop);
      sendBtn.setAttribute("aria-label", stop ? "Stop" : "Send");
      sendBtn.setAttribute("title", stop ? "Stop agent" : "Send");
    }
  }

  function submitText(text: string): void {
    const t = text.trim();
    if (!t) return;
    // While the agent is running the button is a stop button — Enter
    // must not queue a second task (parity with the old disabled-input
    // behaviour; the input itself is disabled during a run anyway).
    if (isProcessing) return;
    if (input) {
      input.value = "";
      input.style.height = "";
      input.style.overflowY = "hidden";
    }
    sendHandler?.(t);
  }

  if (sendBtn) {
    sendBtn.addEventListener("click", () => {
      if (isProcessing) {
        cancelHandler?.();
        return;
      }
      if (input) submitText(input.value);
    });
  }

  if (input) {
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submitText(input.value);
      }
    });

    // Auto-grow: starts single-line (~24px) and grows dynamically
    // up to 120px, switching to internal scroll when capped.
    const autoGrow = () => {
      input.style.height = "auto";
      const newHeight = Math.min(input.scrollHeight, 120);
      input.style.height = Math.max(newHeight, 24) + "px";
      input.style.overflowY = input.scrollHeight > 120 ? "auto" : "hidden";
    };
    input.addEventListener("input", autoGrow);
  }

  // Suggestion chips (empty state) — clicking one submits the task.
  // The "Working on:" line toggles its expandable detail panel.
  if (conversation) {
    conversation.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest?.(
        ".rv-chip-suggest"
      ) as HTMLElement | null;
      if (chip?.dataset.suggest) {
        submitText(chip.dataset.suggest);
        return;
      }
      const workingLine = (e.target as HTMLElement).closest?.(
        "[data-working-toggle]"
      ) as HTMLElement | null;
      if (workingLine) {
        const block = workingLine.closest(".rv-processing") as HTMLElement | null;
        if (block) {
          const expanded = block.classList.toggle("rv-expanded");
          workingLine.setAttribute("aria-expanded", expanded ? "true" : "false");
          refreshWorkingDetail();
        }
        return;
      }
    });
  }

  // ---- Header buttons ----

  if (minimizeBtn) {
    minimizeBtn.addEventListener("click", () => {
      minimizeHandler?.();
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      closeHandler?.();
    });
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => {
      closeHandler?.();
    });
  }

  // ---- Drag (pointer events) ----
  //
  // The card is positioned via absolute left/top (set inline by the
  // caller's morph/anchor logic). Dragging updates left/top directly,
  // clamped to the viewport, and fires onDragEnd() with the final
  // absolute position on release.

  let dragStart: { pointerX: number; pointerY: number; baseX: number; baseY: number } | null = null;

  const clampPos = (x: number, y: number): { x: number; y: number } => {
    // Clamp the card to the viewport so it can't be dragged offscreen.
    const maxX = Math.max(0, window.innerWidth - root.offsetWidth);
    const maxY = Math.max(0, window.innerHeight - root.offsetHeight);
    return {
      x: Math.min(Math.max(0, x), maxX),
      y: Math.min(Math.max(0, y), maxY),
    };
  };

  const applyPos = (x: number, y: number): void => {
    const p = clampPos(x, y);
    root.style.left = `${p.x}px`;
    root.style.top = `${p.y}px`;
    root.style.right = "auto";
    root.style.bottom = "auto";
  };

  if (dragHandle) {
    dragHandle.addEventListener("pointerdown", (e) => {
      // Ignore drags that started on the header buttons (they handle their
      // own clicks). The buttons are not inside the drag handle, but be safe.
      if ((e.target as HTMLElement).closest("button")) return;
      if (e.button !== 0) return;

      e.preventDefault();
      try {
        dragHandle.setPointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      const rect = root.getBoundingClientRect();
      dragStart = {
        pointerX: e.clientX,
        pointerY: e.clientY,
        baseX: rect.left,
        baseY: rect.top,
      };
    });

    dragHandle.addEventListener("pointermove", (e) => {
      if (!dragStart) return;
      applyPos(
        dragStart.baseX + (e.clientX - dragStart.pointerX),
        dragStart.baseY + (e.clientY - dragStart.pointerY)
      );
    });

    const endDrag = (e: PointerEvent) => {
      if (!dragStart) return;
      try {
        dragHandle.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      // Read the final absolute position back from the live style.
      const fx = parseFloat(root.style.left || "0");
      const fy = parseFloat(root.style.top || "0");
      dragEndHandler?.({ dx: fx, dy: fy });
      dragStart = null;
    };

    dragHandle.addEventListener("pointerup", endDrag);
    dragHandle.addEventListener("pointercancel", endDrag);
  }

  // ---- Conversation scrolling (top-grow behaviour) ----
  //
  // The conversation is top-anchored (CSS flex-start + a visible top
  // gap): short conversations start near the top with breathing room
  // and grow downward. Auto-scroll fires only when the user is already
  // at (or near) the bottom, or when `force` is set — so new content
  // never yanks the view if the user scrolled up to read.

  function isNearBottom(): boolean {
    if (!conversation) return true;
    const threshold = 48;
    return (
      conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight <
      threshold
    );
  }

  function scrollConversationToBottom(force = false): void {
    if (!conversation) return;
    if (!force && !isNearBottom()) return;
    conversation.scrollTop = conversation.scrollHeight;
  }

  // ---- Live processing view ----
  //
  // ONE compact collapsible line while the agent works:
  //   [spinner] Working on: <short step>   2.1s   ▾
  // Clicking the line expands a slim detail list (step timeline +
  // privacy summary). Clicking again collapses it. The block is
  // REPLACED by the compact summary card when the agent finishes.

  type Step = { key: string; label: string; done: boolean; active: boolean };
  let currentProcessing: {
    el: HTMLElement;
    stepsEl: HTMLElement | null;
    stepLabelEl: HTMLElement | null;
    elapsedEl: HTMLElement | null;
    detailEl: HTMLElement | null;
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

  /** Short phrase shown after "Working on:" for each pipeline step. */
  const STEP_PHRASES: Record<string, string> = {
    perceive: "analyzing the page",
    privacy: "protecting sensitive data",
    context: "preparing sanitized context",
    plan: "planning the next action",
    execute: "executing actions",
  };

  function renderWorkingSteps(stepsEl: HTMLElement | null, steps: Step[]): void {
    if (!stepsEl) return;
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

  function renderWorkingPrivacy(): string {
    const s = lastRedactionSummary;
    if (!s || !s.count) {
      return `<div class="rv-working-privacy-row"><span class="rv-working-privacy-icon">🛡</span><span>No sensitive items detected yet</span></div>`;
    }
    const pills = Object.keys(s.byType)
      .map(
        (t) =>
          `<span class="rv-redaction-pill" data-type="${escapeAttr(t)}"><span class="rv-redaction-icon">${iconForType(t)}</span><span class="rv-redaction-type">[${escapeHtml(t)}]</span><span class="rv-redaction-count">${s.byType[t]}</span></span>`
      )
      .join("");
    return `<div class="rv-working-privacy-row"><span class="rv-working-privacy-icon">🛡</span><span>${s.count} sensitive value${s.count === 1 ? "" : "s"} protected locally</span></div><div class="rv-working-privacy-pills">${pills}</div>`;
  }

  function refreshWorkingDetail(): void {
    if (!currentProcessing) return;
    const cp = currentProcessing;
    renderWorkingSteps(cp.stepsEl, cp.steps);
    const privacyEl = cp.detailEl?.querySelector<HTMLElement>("[data-working-privacy]");
    if (privacyEl) privacyEl.innerHTML = renderWorkingPrivacy();
  }

  function startProcessing(): void {
    if (!conversation) return;
    // First clear the empty placeholder.
    const placeholder = conversation.querySelector(".rv-empty");
    if (placeholder) placeholder.remove();
    suggestRow?.classList.add("rv-hidden");

    // Tear down any prior processing block.
    if (currentProcessing) endProcessing("completed", "");

    const startedAt = Date.now();
    const el = document.createElement("div");
    el.className = "rv-processing";
    el.innerHTML = `
      <button type="button" class="rv-working-line" data-working-toggle aria-expanded="false">
        <span class="rv-processing-spinner"></span>
        <span class="rv-working-text">Working on: <span class="rv-working-step" data-working-step>analyzing the page</span></span>
        <span class="rv-processing-elapsed">0.0s</span>
        <span class="rv-working-chevron">▾</span>
      </button>
      <div class="rv-working-detail">
        <div class="rv-processing-steps"></div>
        <div class="rv-working-privacy" data-working-privacy></div>
      </div>
    `;
    conversation.appendChild(el);
    const stepsEl = el.querySelector<HTMLElement>(".rv-processing-steps");
    const stepLabelEl = el.querySelector<HTMLElement>("[data-working-step]");
    const elapsedEl = el.querySelector<HTMLElement>(".rv-processing-elapsed");
    const detailEl = el.querySelector<HTMLElement>(".rv-working-detail");

    const steps: Step[] = DEFAULT_STEPS.map((s) => ({ ...s }));
    currentProcessing = { el, stepsEl, stepLabelEl, elapsedEl, detailEl, startedAt, steps, timer: null };
    refreshWorkingDetail();

    const timer = setInterval(() => {
      const s = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (currentProcessing?.elapsedEl) currentProcessing.elapsedEl.textContent = `${s}s`;
    }, 100);
    if (currentProcessing) currentProcessing.timer = timer;

    scrollConversationToBottom(true);
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
    renderWorkingSteps(cp.stepsEl, cp.steps);
    if (cp.stepLabelEl) {
      cp.stepLabelEl.textContent =
        currentAction && currentAction.trim()
          ? currentAction
          : STEP_PHRASES[key] || "working";
    }
    scrollConversationToBottom();
  }

  function endProcessing(_phase: string, _finalMessage: string): void {
    if (!currentProcessing) return;
    const cp = currentProcessing;
    if (cp.timer) clearInterval(cp.timer);
    // Animate out: collapse, then remove.
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

    // Update the live working line (if active).
    if (currentProcessing) {
      const m = mapStageToProcessing(activity);
      if (m) {
        updateProcessingStep(m.key, m.current);
      }
    }

    // Thought activities (stage / llm_thinking) are intentionally
    // NOT streamed as raw rows — they live inside the collapsible
    // "Working on:" line. Action lifecycle events (planned/validated/
    // executed) are recorded into the detail timeline, also visible
    // by expanding the working line or the "Details" panel.
    if (
      activity.kind === "stage" ||
      activity.kind === "llm_thinking" ||
      activity.kind === "action_planned" ||
      activity.kind === "action_validated" ||
      activity.kind === "action_executed" ||
      activity.kind === "iteration_complete"
    ) {
      return;
    }

    // Skip duplicate user echo (already shown when send was pressed).
    if (activity.kind === "user") {
      // No-op: we already appended the bubble in clearConversation->onSend.
      return;
    }

    // User-facing events (missing_info, error, action_rejected, info)
    // still render as slim message rows in the conversation.
    const block = document.createElement("div");
    block.className = `rv-msg rv-${activity.kind} rv-slim`;
    block.dataset.id = activity.id;
    block.innerHTML = `
      <div class="rv-msg-icon">${iconFor(activity.kind)}</div>
      <div class="rv-msg-main">
        <div class="rv-msg-row">
          <div class="rv-msg-body">
            <span class="rv-msg-text">${escapeHtml(activity.text)}</span>
            ${activity.detail ? `<span class="rv-msg-detail">${escapeHtml(activity.detail)}</span>` : ""}
          </div>
        </div>
      </div>
    `;
    if (conversation) {
      conversation.appendChild(block);
      scrollConversationToBottom();
    }
  }

  function appendUserBubble(text: string): void {
    if (!conversation) return;
    const placeholder = conversation.querySelector(".rv-empty");
    if (placeholder) placeholder.remove();
    // The suggestion chips live just above the composer; once a real
    // conversation starts they are no longer relevant.
    suggestRow?.classList.add("rv-hidden");
    const block = document.createElement("div");
    block.className = "rv-msg rv-user";
    block.innerHTML = `<div class="rv-msg-bubble">${escapeHtml(text)}</div>`;
    conversation.appendChild(block);
    scrollConversationToBottom(true);
  }

  // ---- Status & backend pill ----

  function setStatus(
    state: "ready" | "thinking" | "completed" | "error",
    label: string
  ): void {
    if (statusDot) {
      statusDot.className = `rv-chat-dot rv-${state}`;
    }
    if (headerStatus) {
      headerStatus.textContent = label;
    }
    if (privacyBar) {
      if (state === "thinking") {
        privacyBar.classList.add("rv-active");
      } else {
        privacyBar.classList.remove("rv-active");
      }
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
    lastRedactionSummary = summary;
    // Keep the collapsible working-line detail in sync while running.
    if (currentProcessing) {
      refreshWorkingDetail();
    }
    if (!conversation || !root) return;
    // Compact single-line privacy status (full token table lives in
    // the Details panel → "Sanitized data" tab).
    let card = root.querySelector<HTMLElement>(".rv-redaction-card");
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
                  <span class="rv-redaction-type">${escapeHtml(t)}</span>
                  <span class="rv-redaction-count">${count}</span>
                </span>`;
      })
      .join("");

    card.innerHTML = `
      <span class="rv-redaction-shield">🛡</span>
      <span class="rv-redaction-count-total">${summary.count} protected</span>
      <span class="rv-redaction-pills">${pills}</span>
      <span class="rv-redaction-safety ${summary.count > 0 ? "rv-safe" : "rv-neutral"}">
        ${summary.count > 0 ? "● safe" : "○ nothing to redact"}
      </span>
      ${summary.inProgress ? '<span class="rv-redaction-state rv-busy">Sanitizing…</span>' : ""}
    `;

    if (summary.inProgress) {
      if (privacyBar) privacyBar.classList.add("rv-active");
    } else if (statusDot && !statusDot.classList.contains("rv-thinking")) {
      if (privacyBar) privacyBar.classList.remove("rv-active");
    }
  }

  // Last summary data — used by the copy button.
  let lastSummary: TaskSummary | null = null;

  /** One-line stat string, e.g. "5 actions · 3.7s · 4 items protected". */
  function summaryStatsLine(summary: TaskSummary): string {
    const parts: string[] = [];
    if (summary.actionsExecuted > 0) {
      parts.push(
        `${summary.actionsExecuted} action${summary.actionsExecuted === 1 ? "" : "s"}`
      );
    }
    parts.push(`${(summary.durationMs / 1000).toFixed(1)}s`);
    const privacyCount = summary.privacy?.count ?? 0;
    parts.push(
      privacyCount > 0
        ? `${privacyCount} item${privacyCount === 1 ? "" : "s"} protected`
        : "nothing to protect"
    );
    return parts.join(" · ");
  }

  /** Plain-text summary copied to the clipboard by the copy button. */
  function summaryToText(summary: TaskSummary): string {
    const header =
      summary.phase === "completed"
        ? "RedactVision Agent — Task completed"
        : summary.phase === "offline"
        ? "RedactVision Agent — Server agent offline"
        : summary.phase === "cancelled"
        ? "RedactVision Agent — Task cancelled"
        : summary.phase === "max_iterations_reached"
        ? "RedactVision Agent — Agent stopped"
        : "RedactVision Agent — Task failed";
    const lines = [header, summaryStatsLine(summary)];
    if (summary.reason) lines.push(summary.reason);
    const privacy = summary.privacy;
    if (privacy && privacy.count > 0) {
      const byType = Object.entries(privacy.byType)
        .map(([t, n]) => `${t}: ${n}`)
        .join(", ");
      lines.push(`Privacy: ${privacy.count} sensitive value(s) tokenized locally (${byType}). Server never received raw PII.`);
    } else {
      lines.push("Privacy: no sensitive items on this page.");
    }
    return lines.join("\n");
  }

  async function copySummaryToClipboard(summary: TaskSummary): Promise<boolean> {
    const text = summaryToText(summary);
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fallback for pages that block the async clipboard API.
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        return ok;
      } catch {
        return false;
      }
    }
  }

  function showSummary(summary: TaskSummary): void {
    // Replace live processing (if still up) with the summary card.
    endProcessing(summary.phase, summary.message);
    // A fresh summary invalidates the previous details view.
    closeDetails();
    lastSummary = summary;

    // Build the compact summary card.
    const isOk = summary.phase === "completed";
    const isFailed = summary.phase === "failed";
    const isCapped = summary.phase === "max_iterations_reached";
    const isOffline = summary.phase === "offline";
    const variantClass = isFailed || isOffline
      ? "rv-summary-failed"
      : isCapped
      ? "rv-summary-capped"
      : "rv-summary-ok";
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

    // Single subtitle line with key stats (reason shown as a second
    // muted line only when there is one — still compact).
    const subtitle = summaryStatsLine(summary);
    const reasonLine = summary.reason
      ? `<div class="rv-summary-reason">${escapeHtml(summary.reason)}</div>`
      : "";

    const card = document.createElement("div");
    card.className = `rv-summary ${variantClass}`;
    card.innerHTML = `
      <div class="rv-summary-head">
        <div class="rv-summary-icon">${iconChar}</div>
        <div class="rv-summary-titles">
          <div class="rv-summary-title">${escapeHtml(title)}</div>
          <div class="rv-summary-sub">${escapeHtml(subtitle)}</div>
          ${reasonLine}
        </div>
        <div class="rv-summary-tools">
          <button type="button" class="rv-summary-copy" data-summary-copy title="Copy summary" aria-label="Copy summary">⧉</button>
          <button type="button" class="rv-summary-toggle" data-summary-toggle title="Timeline &amp; sanitized data">Details</button>
        </div>
      </div>
    `;

    // Insert the summary card right after the redaction card (if any)
    // so privacy info stays visible above the result.
    if (conversation) {
      const redaction = conversation.querySelector(".rv-redaction-card");
      if (redaction && redaction.nextSibling) {
        conversation.insertBefore(card, redaction.nextSibling);
      } else {
        conversation.appendChild(card);
      }
    }

    // Copy button — copies a plain-text summary of the result.
    const copyBtn = card.querySelector<HTMLButtonElement>("[data-summary-copy]");
    if (copyBtn) {
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const ok = await copySummaryToClipboard(summary);
        copyBtn.textContent = ok ? "✓" : "✕";
        copyBtn.title = ok ? "Copied!" : "Copy failed";
        setTimeout(() => {
          copyBtn.textContent = "⧉";
          copyBtn.title = "Copy summary";
        }, 1400);
      });
    }

    // Wire the "Details" toggle to open the full-screen details
    // panel (timeline + sanitized data) inside the card.
    const toggle = card.querySelector<HTMLButtonElement>("[data-summary-toggle]");
    summaryToggleBtn = toggle;
    if (toggle) {
      toggle.addEventListener("click", () => {
        const isOpen = detailsPanel?.classList.contains("rv-open");
        if (isOpen) {
          closeDetails();
        } else {
          openDetails("timeline");
        }
      });
    }

    scrollConversationToBottom(true);
  }

  function showValidationError(error: ValidationError): void {
    // End any live processing animation
    endProcessing("failed", "Validation error");

    const card = document.createElement("div");
    card.className = "rv-summary rv-summary-validation";
    card.innerHTML = `
      <div class="rv-summary-head">
        <div class="rv-summary-icon">⚠</div>
        <div class="rv-summary-titles">
          <div class="rv-summary-title">Validation error: ${escapeHtml(error.field)}</div>
          <div class="rv-summary-sub">${escapeHtml(error.issue)}</div>
        </div>
      </div>
      <div class="rv-validation-details">
        <div class="rv-validation-row">
          <span class="rv-validation-label">You entered:</span>
          <span class="rv-validation-value">${escapeHtml(error.userValue || "(empty)")}</span>
        </div>
        <div class="rv-validation-row">
          <span class="rv-validation-label">Expected:</span>
          <span class="rv-validation-expected">${escapeHtml(error.expected)}</span>
        </div>
      </div>
      <div class="rv-validation-actions">
        <button type="button" class="rv-validation-retry-btn" data-validation-retry>
          Fix &amp; try again
        </button>
      </div>
    `;

    // Insert right after redaction card or at the end
    if (conversation) {
      const redaction = conversation.querySelector(".rv-redaction-card");
      if (redaction && redaction.nextSibling) {
        conversation.insertBefore(card, redaction.nextSibling);
      } else {
        conversation.appendChild(card);
      }
    }

    // Wire retry button to refocus input and clear current value for quick correction
    const retryBtn = card.querySelector<HTMLButtonElement>("[data-validation-retry]");
    if (retryBtn) {
      retryBtn.addEventListener("click", () => {
        focusInput();
        setInputValue("");
        card.remove();
      });
    }

    scrollConversationToBottom(true);
  }

  function showSystemError(error: SystemError): void {
    // End any live processing animation
    endProcessing("failed", error.title);

    const iconMap = {
      extension_context_invalidated: "🔄",
      server_unreachable: "🌐",
      runtime_error: "⚠",
    };

    const card = document.createElement("div");
    card.className = "rv-summary rv-summary-failed";
    card.innerHTML = `
      <div class="rv-summary-head">
        <div class="rv-summary-icon">${iconMap[error.type] || "⚠"}</div>
        <div class="rv-summary-titles">
          <div class="rv-summary-title">${escapeHtml(error.title)}</div>
          <div class="rv-summary-sub">${escapeHtml(error.message)}</div>
        </div>
      </div>
      <div class="rv-validation-actions">
        <button type="button" class="rv-validation-retry-btn" data-system-error-action="${error.actionType}">
          ${error.actionLabel}
        </button>
      </div>
    `;

    // Insert right after redaction card or at the end
    if (conversation) {
      const redaction = conversation.querySelector(".rv-redaction-card");
      if (redaction && redaction.nextSibling) {
        conversation.insertBefore(card, redaction.nextSibling);
      } else {
        conversation.appendChild(card);
      }
    }

    // Wire action button
    const actionBtn = card.querySelector<HTMLButtonElement>("[data-system-error-action]");
    if (actionBtn) {
      actionBtn.addEventListener("click", () => {
        if (error.actionType === "refresh") {
          window.location.reload();
        } else if (error.actionType === "retry") {
          focusInput();
          card.remove();
        }
      });
    }

    scrollConversationToBottom(true);
  }

  // ---- Details panel (Timeline + Sanitized data) ----

  function openDetails(tab: "timeline" | "data"): void {
    if (!root) return;
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
        <button type="button" class="rv-details-hide" data-details-hide aria-label="Hide details">
          Hide details <span class="rv-details-hide-chevron">▾</span>
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
          .map((a, idx) => {
            const time = new Date(a.timestamp).toLocaleTimeString([], {
              hour: "2-digit",
              minute: "2-digit",
              second: "2-digit",
            });
            const stepNumber = idx + 1;
            return `
              <div class="rv-details-item rv-dt-${a.kind}">
                <div class="rv-details-item-step">${stepNumber}</div>
                <div class="rv-details-item-icon">${iconForActivity(a)}</div>
                <div class="rv-details-item-body">
                  <div class="rv-details-item-text">${escapeHtml(a.text)}</div>
                  ${a.detail ? `<div class="rv-details-item-detail">${escapeHtml(a.detail)}</div>` : ""}
                  ${buildActivityMeta(a)}
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
        // Compute PII type distribution for graphical analysis
        const privacyByType: Record<string, number> = {};
        sanitizedData.tokens.forEach((t) => {
          const type = t.type.toUpperCase();
          privacyByType[type] = (privacyByType[type] || 0) + 1;
        });
        const totalTokens = sanitizedData.tokens.length;
        const sortedTypes = Object.entries(privacyByType).sort((a, b) => b[1] - a[1]);

        // Build multi-segment distribution bar
        let distributionBar = "";
        if (totalTokens > 0) {
          const segments = sortedTypes.map(([type, count]) => {
            const percent = ((count / totalTokens) * 100).toFixed(1);
            const colorMap: Record<string, string> = {
              EMAIL: "#6366f1",
              PHONE: "#8b5cf6",
              PASSWORD: "#ec4899",
              PERSON: "#14b8a6",
              CARD: "#f59e0b",
              ADDRESS: "#06b6d4",
            };
            const color = colorMap[type] || "#64748b";
            return `<div class="rv-dist-segment" style="flex: ${count}; background: ${color};" title="${type}: ${count} (${percent}%)"></div>`;
          }).join("");
          distributionBar = `<div class="rv-dist-bar">${segments}</div>`;
        }

        // Build category chips
        const categoryChips = sortedTypes.map(([type, count]) => {
          const icon = iconForType(type);
          return `<div class="rv-category-chip" data-type="${escapeHtml(type)}"><span class="rv-category-icon">${icon}</span><span class="rv-category-label">${escapeHtml(type)}</span><span class="rv-category-count">${count}</span></div>`;
        }).join("");

        const tokenRows = sanitizedData.tokens.length
          ? sanitizedData.tokens
              .map(
                (t) => `
              <div class="rv-token-row" data-type="${escapeHtml(t.type.toUpperCase())}">
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
          <div class="rv-graphical-analysis">
            <div class="rv-analysis-title">Privacy Protection Analysis</div>
            ${totalTokens > 0 ? `
              <div class="rv-analysis-section">
                <div class="rv-analysis-label">PII Distribution</div>
                ${distributionBar}
                <div class="rv-category-chips">${categoryChips}</div>
              </div>
            ` : ""}
            <div class="rv-analysis-metrics">
              <div class="rv-metric-card">
                <div class="rv-metric-icon">🛡️</div>
                <div class="rv-metric-body">
                  <div class="rv-metric-value">100%</div>
                  <div class="rv-metric-label">Protection Rate</div>
                </div>
              </div>
              <div class="rv-metric-card">
                <div class="rv-metric-icon">📊</div>
                <div class="rv-metric-body">
                  <div class="rv-metric-value">${sanitizedData.elementCount}</div>
                  <div class="rv-metric-label">Elements Analyzed</div>
                </div>
              </div>
              <div class="rv-metric-card">
                <div class="rv-metric-icon">🔑</div>
                <div class="rv-metric-body">
                  <div class="rv-metric-value">${totalTokens}</div>
                  <div class="rv-metric-label">Active Tokens</div>
                </div>
              </div>
            </div>
          </div>
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
    // Labeled "Hide details" pill + the small × both collapse the panel.
    detailsPanel.querySelector("[data-details-hide]")?.addEventListener("click", closeDetails);
    detailsPanel.querySelector("[data-details-close]")?.addEventListener("click", closeDetails);
  }

  function setInputEnabled(enabled: boolean): void {
    if (input) input.disabled = !enabled;
    // The circular composer button flips between send (idle) and
    // stop (working) modes — stop is wired to the same cancelHandler
    // the old "Cancel" button used.
    setSendMode(!enabled);
    if (enabled && input) input.focus();
  }

  function focusInput(): void {
    if (input) input.focus();
  }

  function setInputValue(v: string): void {
    if (input) input.value = v;
  }

  function setMinimized(minimized: boolean): void {
    if (root) root.classList.toggle("rv-minimized", minimized);
  }

  function setDragOffset(x: number, y: number): void {
    // Absolute viewport position (left/top), clamped on-screen.
    applyPos(x, y);
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
    if (root) root.classList.toggle("rv-light", light);
    // Theme toggle is now a header 3-dot menu item — keep its icon in sync.
    if (menuThemeIcon) {
      menuThemeIcon.textContent = light ? "☀️" : "🌙";
    }
    if (quickSettings) {
      quickSettings
        .querySelectorAll<HTMLButtonElement>("[data-qs-theme]")
        .forEach((b) =>
          b.classList.toggle("rv-active", b.dataset.qsTheme === currentTheme)
        );
    }
  }

  function setAutoRedactState(enabled: boolean): void {
    if (qsAutoRedact) qsAutoRedact.checked = enabled;
  }

  // ---- Header 3-dot menu & quick settings wiring ----
  //
  // The old footer statusbar (brand + duplicate status pill + gear/theme/
  // info buttons) is gone. Every secondary control now lives behind the
  // single ⋯ button in the header. Each item reuses the EXISTING handlers:
  //   Quick Settings → #rv-quick-settings popover (theme + auto-redact)
  //   Toggle Theme   → themeToggleHandler (same as the old 🌙 button)
  //   Activity Log   → openDetails("timeline")
  //   Sanitized Data → openDetails("data")

  function isMenuOpen(): boolean {
    return !!menuDropdown?.classList.contains("rv-open");
  }

  function openMenu(): void {
    if (!menuDropdown || !menuBtn) return;
    menuDropdown.classList.add("rv-open");
    menuDropdown.setAttribute("aria-hidden", "false");
    menuBtn.setAttribute("aria-expanded", "true");
  }

  function closeMenu(): void {
    if (!menuDropdown || !menuBtn) return;
    menuDropdown.classList.remove("rv-open");
    menuDropdown.setAttribute("aria-hidden", "true");
    menuBtn.setAttribute("aria-expanded", "false");
  }

  function toggleMenu(): void {
    if (isMenuOpen()) closeMenu();
    else openMenu();
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu();
    });
  }

  // Menu items — every action maps to existing functionality (no dead UI).
  if (menuDropdown) {
    menuDropdown.querySelectorAll<HTMLButtonElement>("[data-menu-action]").forEach((item) => {
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        const action = item.dataset.menuAction;
        if (action === "settings") {
          // Open the existing quick-settings popover (theme + auto-redact).
          quickSettings?.classList.add("rv-open");
          closeMenu();
          return;
        }
        if (action === "theme") {
          themeToggleHandler?.(currentTheme === "dark" ? "light" : "dark");
          closeMenu();
          return;
        }
        if (action === "timeline") {
          openDetails("timeline");
          closeMenu();
          return;
        }
        if (action === "data") {
          openDetails("data");
          closeMenu();
          return;
        }
      });
    });
  }

  // Keyboard accessibility: Enter/Space fire click natively on <button>;
  // arrow-key navigation inside the dropdown for power users.
  if (menuDropdown) {
    menuDropdown.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
      const items = Array.from(
        menuDropdown.querySelectorAll<HTMLButtonElement>("[data-menu-action]")
      ).filter((el) => !el.hasAttribute("disabled"));
      if (!items.length) return;
      e.preventDefault();
      const idx = items.indexOf(document.activeElement as HTMLButtonElement);
      const next =
        e.key === "ArrowDown"
          ? items[(idx + 1 + items.length) % items.length]
          : items[(idx - 1 + items.length) % items.length];
      next?.focus();
    });
  }

  // Escape closes the menu (and the quick-settings popover if open).
  root.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (isMenuOpen()) {
      e.stopPropagation();
      closeMenu();
      menuBtn?.focus();
    }
    quickSettings?.classList.remove("rv-open");
  });

  if (quickSettings) {
    quickSettings.querySelectorAll<HTMLButtonElement>("[data-qs-theme]").forEach((b) => {
      b.addEventListener("click", () => {
        themeToggleHandler?.(b.dataset.qsTheme as "dark" | "light");
      });
    });
  }

  if (qsAutoRedact) {
    qsAutoRedact.addEventListener("change", () => {
      autoRedactHandler?.(qsAutoRedact.checked);
    });
  }

  // Suggestion chips ("Try: scroll down · click submit · fill the email")
  // moved from the empty state to a row just above the composer.
  if (suggestRow) {
    suggestRow.addEventListener("click", (e) => {
      const chip = (e.target as HTMLElement).closest?.(
        ".rv-chip-suggest"
      ) as HTMLElement | null;
      if (chip?.dataset.suggest) submitText(chip.dataset.suggest);
    });
  }

  // Close the quick-settings popover and the 3-dot menu when clicking
  // anywhere else in the card.
  root.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    if (
      quickSettings?.classList.contains("rv-open") &&
      !quickSettings.contains(target) &&
      !menuBtn?.contains(target)
    ) {
      quickSettings.classList.remove("rv-open");
    }
    if (
      menuDropdown?.classList.contains("rv-open") &&
      !menuDropdown.contains(target) &&
      !menuBtn?.contains(target)
    ) {
      closeMenu();
    }
  });

  function clearConversation(): void {
    // Tear down the live processing block (if any).
    if (currentProcessing) {
      if (currentProcessing.timer) clearInterval(currentProcessing.timer);
      currentProcessing.el.remove();
      currentProcessing = null;
    }
    // Collapse the details panel and drop the stale toggle reference —
    // otherwise the panel keeps overlaying the card with old content
    // and the summary toggle points at a removed node.
    closeDetails();
    summaryToggleBtn = null;
    detailedTimeline = [];
    lastSummary = null;
    if (conversation) {
      conversation.innerHTML = emptyStateHTML();
    }
    // The card is back to an empty state — show the suggestion chips again.
    suggestRow?.classList.remove("rv-hidden");
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
    showValidationError,
    showSystemError,
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
          <div class="rv-chat-avatar"><img class="rv-avatar-img" data-rv-logo src="${rvLogoUrl()}" alt="RedactVision" draggable="false" /></div>
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
          <button class="rv-icon-btn rv-menu-btn" id="rv-menu-btn" type="button" title="Menu" aria-label="Open menu" aria-haspopup="true" aria-expanded="false">⋯</button>
          <button class="rv-icon-btn" id="rv-minimize-btn" type="button" title="Minimize" aria-label="Minimize">−</button>
          <button class="rv-icon-btn rv-close" id="rv-close-btn" type="button" title="Close" aria-label="Close">×</button>
        </div>
      </header>

      <!-- 3-dot dropdown: the single entry point for all secondary controls. -->
      <div class="rv-menu" id="rv-menu" role="menu" aria-hidden="true" aria-label="Chat menu">
        <button type="button" class="rv-menu-item" role="menuitem" data-menu-action="settings" title="Theme & auto-redact">
          <span class="rv-menu-ic">⚙️</span><span class="rv-menu-label">Quick Settings</span>
        </button>
        <button type="button" class="rv-menu-item" role="menuitem" data-menu-action="theme" title="Toggle light / dark theme">
          <span class="rv-menu-ic" id="rv-menu-theme-icon">🌙</span><span class="rv-menu-label">Toggle Theme</span>
        </button>
        <button type="button" class="rv-menu-item" role="menuitem" data-menu-action="timeline" title="Agent execution history">
          <span class="rv-menu-ic">📋</span><span class="rv-menu-label">Activity Log</span>
        </button>
        <button type="button" class="rv-menu-item" role="menuitem" data-menu-action="data" title="Sanitized data this page">
          <span class="rv-menu-ic">🛡️</span><span class="rv-menu-label">Sanitized Data</span>
        </button>
      </div>

      <main class="rv-conversation" id="rv-conversation">${emptyStateHTML()}</main>

      <footer class="rv-composer">
        <!-- Suggestion chips moved here from the old empty state -->
        <div class="rv-suggest-row" id="rv-suggest-row">
          <span class="rv-suggest-label">Try:</span>
          <button type="button" class="rv-chip-suggest" data-suggest="scroll down">
            <span class="rv-chip-ic">↓</span> scroll down
          </button>
          <button type="button" class="rv-chip-suggest" data-suggest="click submit">
            <span class="rv-chip-ic">↖</span> click submit
          </button>
          <button type="button" class="rv-chip-suggest" data-suggest="fill the email">
            <span class="rv-chip-ic">✎</span> fill the email
          </button>
        </div>
        <div class="rv-input-pill" id="rv-input-pill">
          <button class="rv-attach-btn" id="rv-attach-btn" type="button" title="Attachments coming soon" disabled>+</button>
          <textarea
            id="rv-input"
            class="rv-input"
            rows="1"
            placeholder="Ask RedactVision anything…"
          ></textarea>
          <button class="rv-send-btn" id="rv-send-btn" type="button" aria-label="Send" title="Send">
            <span class="rv-send-icon">↑</span>
            <span class="rv-stop-icon">■</span>
          </button>
        </div>
        <div class="rv-disclaimer">Agent can make mistakes. Please double-check.</div>
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
      <div class="rv-empty-hint">Pick a suggestion below or type your own task.</div>
    </div>
  `;
}

/**
 * Expand/collapse is now handled by the collapsible "Working on:"
 * line (see the [data-working-toggle] handler in buildChatUI).
 */

/**
 * Build the (factual) meta rows for a timeline item. Only real
 * telemetry from the agent pipeline is shown — no invented reasoning.
 * Sensitive values are never present here: the session tokenizes
 * them before any activity is emitted.
 */
function buildActivityMeta(activity: AgentActivity): string {
  const meta = (activity.meta || {}) as Record<string, unknown>;
  const rows: string[] = [];
  const add = (label: string, value: string, mono = false): void => {
    rows.push(
      `<div class="rv-x-row"><span class="rv-x-label">${escapeHtml(label)}</span>` +
        `<span class="rv-x-value${mono ? " rv-mono" : ""}">${escapeHtml(value)}</span></div>`
    );
  };

  if (activity.detail) add("Detail", activity.detail);

  const action = meta.action as Record<string, unknown> | undefined;
  if (action && typeof action.action === "string") {
    add("Action", actionCodeRepr(action), true);
  }
  if (typeof meta.source === "string") add("Source", meta.source, true);
  if (action && typeof action.confidence === "number") {
    add("Confidence", `${Math.round(action.confidence * 100)}%`, true);
  }
  if (typeof meta.confidence === "number") {
    add("Confidence", `${Math.round(meta.confidence * 100)}%`, true);
  }
  if (typeof meta.durationMs === "number") {
    add("Duration", `${Math.round(meta.durationMs)}ms`, true);
  }
  if (typeof meta.errorCode === "string") add("Error code", meta.errorCode, true);
  if (typeof meta.failedAction === "string") add("Failed action", meta.failedAction, true);

  return rows.join("");
}

/** Compact code-style representation of a planned action (factual). */
function actionCodeRepr(a: Record<string, unknown>): string {
  const kind = String(a.action);
  const target = a.target ? String(a.target) : "";
  const value = a.value !== undefined && a.value !== null ? String(a.value) : "";
  const amount = typeof a.amount === "number" ? a.amount : null;
  switch (kind) {
    case "click":
      return `click(${target || "?"})`;
    case "type":
      return `type(${target || "?"}, "${value.length > 32 ? value.slice(0, 29) + "…" : value}")`;
    case "scroll": {
      const dir = String(a.direction || "down").toLowerCase() === "up" ? -1 : 1;
      return `window.scrollBy(0, ${dir * (amount ?? 500)})`;
    }
    case "select":
      return `select(${target || "?"}, "${value}")`;
    case "wait":
      return `wait(${amount ?? 1000}ms)`;
    case "navigate":
      return `navigate(${target || value || "?"})`;
    default:
      return `${kind} ${target}`.trim();
  }
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
      return "⌨️";  // keyboard icon for typing/clicking actions
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

// Enhanced icon selection based on activity text content for timeline clarity
function iconForActivity(activity: AgentActivity): string {
  const text = activity.text.toLowerCase();

  // Privacy/security-related steps
  if (text.includes("privacy") || text.includes("firewall") || text.includes("sanitiz")) {
    return "🛡️";
  }

  // Typing action
  if (text.includes("type into") || text.includes("typing")) {
    return "⌨️";
  }

  // Click action
  if (text.includes("click")) {
    return "👆";
  }

  // Validation/check steps
  if (text.includes("validat")) {
    return "✓";
  }

  // Analysis/understanding
  if (text.includes("analyz") || text.includes("understand")) {
    return "🔍";
  }

  // Default to kind-based icon
  return iconFor(activity.kind);
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
