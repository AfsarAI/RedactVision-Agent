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
 *       • Agent responses — left-aligned surface
 *       • Thought process — collapsible accordion of stage/llm_thinking blocks
 *       • Redaction summary card — lock/shield pills for each token type
 *       • Action blocks — planned / validated / executed / rejected
 *   - Composer: textarea + send + cancel
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
  /** Set the visible backend pill in the header (e.g. "Groq", "Local rules"). */
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

  let sendHandler: ((text: string) => void) | null = null;
  let cancelHandler: (() => void) | null = null;
  let closeHandler: (() => void) | null = null;
  let minimizeHandler: (() => void) | null = null;
  let dragEndHandler: ((offset: { dx: number; dy: number }) => void) | null = null;

  // ---- Composer ----

  sendBtn.addEventListener("click", () => {
    const text = input.value.trim();
    if (!text) return;
    sendHandler?.(text);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const text = input.value.trim();
      if (text) sendHandler?.(text);
    }
  });

  cancelBtn.addEventListener("click", () => {
    cancelHandler?.();
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

  // ---- Activity rendering ----
  //
  // We group consecutive "thought" activities (stage, llm_thinking)
  // into a single collapsible accordion. As soon as a non-thought
  // activity arrives, the current thought group is "sealed" and a
  // new one opens for the next batch.

  type ThoughtGroup = HTMLElement & { _sealed: boolean };
  let currentThoughtGroup: (HTMLElement & { _sealed: boolean }) | null = null;

  function sealCurrentThoughtGroup(): void {
    if (!currentThoughtGroup) return;
    currentThoughtGroup._sealed = true;
    currentThoughtGroup.classList.add("rv-sealed");
    // Auto-collapse sealed groups so the stream stays readable.
    const body = currentThoughtGroup.querySelector(
      ".rv-thought-body"
    ) as HTMLElement | null;
    const toggle = currentThoughtGroup.querySelector(
      ".rv-thought-toggle"
    ) as HTMLElement | null;
    if (body) body.style.display = "none";
    if (toggle) toggle.classList.add("rv-collapsed");
    const summary = currentThoughtGroup.querySelector(
      ".rv-thought-summary"
    ) as HTMLElement | null;
    if (summary) {
      const n = currentThoughtGroup.querySelectorAll(".rv-msg").length;
      summary.textContent = `· ${n} step${n === 1 ? "" : "s"}`;
    }
    currentThoughtGroup = null;
  }

  function openThoughtGroup(): HTMLDivElement & { _sealed: boolean } {
    sealCurrentThoughtGroup();
    const group = document.createElement("div") as HTMLDivElement & { _sealed: boolean };
    group.className = "rv-thought-group";
    group._sealed = false;
    group.innerHTML = `
      <div class="rv-thought-header" data-rv-thought-toggle>
        <span class="rv-thought-icon">◌</span>
        <span class="rv-thought-title">Thinking</span>
        <span class="rv-thought-toggle rv-collapsed">▾</span>
        <span class="rv-thought-summary"></span>
      </div>
      <div class="rv-thought-body"></div>
    `;
    // Toggle expand/collapse on click
    const header = group.querySelector("[data-rv-thought-toggle]") as HTMLElement;
    const body = group.querySelector(".rv-thought-body") as HTMLElement;
    const toggle = group.querySelector(".rv-thought-toggle") as HTMLElement;
    header.addEventListener("click", () => {
      const collapsed = body.style.display === "none";
      body.style.display = collapsed ? "flex" : "none";
      toggle.classList.toggle("rv-collapsed", !collapsed);
    });
    // New groups are open by default while the agent is actively thinking.
    body.style.display = "flex";
    conversation.appendChild(group);
    return group;
  }

  function appendActivity(activity: AgentActivity): void {
    // First message — drop the empty placeholder.
    const placeholder = conversation.querySelector(".rv-empty");
    if (placeholder) placeholder.remove();

    // User messages render as a standalone right-aligned block (no icon).
    if (activity.kind === "user") {
      sealCurrentThoughtGroup();
      const block = document.createElement("div");
      block.className = "rv-msg rv-user";
      block.dataset.id = activity.id;
      block.innerHTML = `<div class="rv-msg-bubble">${escapeHtml(activity.text)}</div>`;
      conversation.appendChild(block);
      conversation.scrollTop = conversation.scrollHeight;
      return;
    }

    // Thought activities go into a collapsible group.
    if (activity.kind === "stage" || activity.kind === "llm_thinking") {
      if (!currentThoughtGroup || currentThoughtGroup._sealed) {
        currentThoughtGroup = openThoughtGroup();
      }
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
      currentThoughtGroup.querySelector(".rv-thought-body")!.appendChild(block);
      conversation.scrollTop = conversation.scrollHeight;
      return;
    }

    // Anything else (action, info, error, etc.) — seal any open
    // thought group, then render a normal block.
    sealCurrentThoughtGroup();
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
    conversation.appendChild(block);
    conversation.scrollTop = conversation.scrollHeight;
  }

  function clearConversation(): void {
    sealCurrentThoughtGroup();
    currentThoughtGroup = null;
    conversation.innerHTML = `
      <div class="rv-empty">
        <div class="rv-empty-title">Ready when you are</div>
        <div class="rv-empty-hint">
          Try: <code>scroll down</code> · <code>click submit</code> · <code>fill the email</code>
        </div>
      </div>
    `;
  }

  // ---- Status & backend pill ----

  function setStatus(
    state: "ready" | "thinking" | "completed" | "error",
    label: string
  ): void {
    statusDot.className = `rv-chat-dot rv-${state}`;
    headerStatus.textContent = label;
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
    let variant = "rv-local";
    if (lower.includes("groq")) variant = "rv-groq";
    else if (lower.includes("gemini")) variant = "rv-gemini";
    else if (lower.includes("openrouter")) variant = "rv-openrouter";
    else if (lower.includes("nvidia")) variant = "rv-nvidia";
    else if (lower.includes("omni")) variant = "rv-omni";
    else if (lower.includes("hugging") || lower.includes("hf")) variant = "rv-hf";
    else if (lower.includes("local")) variant = "rv-local";
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

  function setInputEnabled(enabled: boolean): void {
    input.disabled = !enabled;
    sendBtn.disabled = !enabled;
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

  // ---- Public wiring ----

  function onSend(handler: (text: string) => void): void {
    sendHandler = handler;
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
    appendActivity,
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
        <div class="rv-backend-pill rv-local" id="rv-backend-pill" title="Active reasoning backend">
          <span class="rv-backend-dot"></span>
          <span id="rv-backend-label">Local</span>
        </div>
        <div class="rv-chat-controls">
          <button class="rv-icon-btn" id="rv-minimize-btn" type="button" title="Minimize" aria-label="Minimize">−</button>
          <button class="rv-icon-btn rv-close" id="rv-close-btn" type="button" title="Close" aria-label="Close">×</button>
        </div>
      </header>

      <main class="rv-conversation" id="rv-conversation">
        <div class="rv-empty">
          <div class="rv-empty-title">Ready when you are</div>
          <div class="rv-empty-hint">
            Try: <code>scroll down</code> · <code>click submit</code> · <code>fill the email</code>
          </div>
        </div>
      </main>

      <footer class="rv-composer">
        <button class="rv-cancel-btn" id="rv-cancel-btn" type="button" hidden>Cancel</button>
        <textarea
          id="rv-input"
          class="rv-input"
          rows="1"
          placeholder="Type a task…  (Enter to send, Shift+Enter for newline)"
        ></textarea>
        <button class="rv-send-btn" id="rv-send-btn" type="button" aria-label="Send">
          <span class="rv-send-icon">➤</span>
        </button>
      </footer>
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
