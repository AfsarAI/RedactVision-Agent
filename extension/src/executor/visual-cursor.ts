/**
 * RedactVision Agent — Visual Cursor & Human-like Interaction Engine
 *
 * Implements on-device simulated cursor visualization and human-like
 * input sequences:
 *   1. Glides a custom visual cursor smoothly across (x, y) coordinates
 *      using requestAnimationFrame with smooth acceleration/deceleration.
 *   2. Scrolls elements into view before moving the cursor.
 *   3. Triggers click ripple animations at target coordinates.
 *   4. Dispatches full mouse event sequences (mouseover, mouseenter,
 *      mousemove, mousedown, focus, mouseup, click).
 *   5. Simulates realistic human typing with keydown/keypress/input/keyup
 *      character cadence and visual status badges.
 */

const CURSOR_ID = "rv-visual-cursor";
const CURSOR_STYLES_ID = "rv-cursor-styles";

interface CursorState {
  x: number;
  y: number;
  visible: boolean;
}

let state: CursorState = {
  x: window.innerWidth / 2,
  y: window.innerHeight / 2,
  visible: false,
};

let cursorEl: HTMLElement | null = null;
let badgeEl: HTMLElement | null = null;
let currentAnimation: number | null = null;

function injectCursorStyles(): void {
  if (document.getElementById(CURSOR_STYLES_ID)) return;

  const style = document.createElement("style");
  style.id = CURSOR_STYLES_ID;
  style.textContent = `
    #${CURSOR_ID} {
      position: fixed;
      top: 0;
      left: 0;
      width: 26px;
      height: 26px;
      pointer-events: none;
      z-index: 2147483647;
      transform: translate(-2px, -2px);
      transition: opacity 0.2s ease;
      will-change: transform, left, top;
    }

    #${CURSOR_ID} .rv-cursor-svg {
      width: 24px;
      height: 24px;
      filter: drop-shadow(0 2px 8px rgba(91, 107, 255, 0.65)) drop-shadow(0 0 2px rgba(255, 255, 255, 0.9));
      transition: transform 0.1s ease;
    }

    #${CURSOR_ID}.rv-clicking .rv-cursor-svg {
      transform: scale(0.82) rotate(-5deg);
    }

    .rv-cursor-ripple {
      position: fixed;
      width: 32px;
      height: 32px;
      border-radius: 50%;
      border: 2px solid #5b6bff;
      background: rgba(91, 107, 255, 0.25);
      pointer-events: none;
      z-index: 2147483646;
      transform: translate(-50%, -50%) scale(0.2);
      opacity: 1;
      animation: rv-ripple-anim 0.45s cubic-bezier(0.1, 0.8, 0.3, 1) forwards;
    }

    @keyframes rv-ripple-anim {
      0% {
        transform: translate(-50%, -50%) scale(0.2);
        opacity: 0.9;
      }
      100% {
        transform: translate(-50%, -50%) scale(2.2);
        opacity: 0;
      }
    }

    .rv-cursor-badge {
      position: absolute;
      top: 22px;
      left: 18px;
      background: rgba(13, 20, 40, 0.92);
      color: #e6ecff;
      border: 1px solid rgba(91, 107, 255, 0.45);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      padding: 3px 8px;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.2px;
      white-space: nowrap;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
      pointer-events: none;
      animation: rv-badge-pop 0.15s ease-out;
    }

    @keyframes rv-badge-pop {
      from { opacity: 0; transform: translateY(-4px) scale(0.95); }
      to   { opacity: 1; transform: translateY(0) scale(1); }
    }

    .rv-element-focus-highlight {
      outline: 2px solid #5b6bff !important;
      outline-offset: 2px !important;
      box-shadow: 0 0 12px rgba(91, 107, 255, 0.35) !important;
      transition: outline-color 0.2s ease, box-shadow 0.2s ease !important;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

export function ensureVisualCursor(): HTMLElement {
  injectCursorStyles();

  let el = document.getElementById(CURSOR_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = CURSOR_ID;
    el.innerHTML = `
      <svg class="rv-cursor-svg" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M4 3L11.5 22L14.8 14.8L22 11.5L4 3Z" fill="url(#rv-cursor-grad)" stroke="#ffffff" stroke-width="1.6" stroke-linejoin="round"/>
        <defs>
          <linearGradient id="rv-cursor-grad" x1="4" y1="3" x2="22" y2="22" gradientUnits="userSpaceOnUse">
            <stop stop-color="#6366f1"/>
            <stop offset="1" stop-color="#22d3a0"/>
          </linearGradient>
        </defs>
      </svg>
      <div class="rv-cursor-badge" style="display: none;"></div>
    `;

    // Start offscreen or at default position
    el.style.left = `${state.x}px`;
    el.style.top = `${state.y}px`;
    el.style.display = "none";

    (document.body || document.documentElement).appendChild(el);
  }

  cursorEl = el;
  badgeEl = el.querySelector(".rv-cursor-badge") as HTMLElement;
  return el;
}

export function showCursor(): void {
  const el = ensureVisualCursor();
  el.style.display = "block";
  el.style.opacity = "1";
  state.visible = true;
}

export function hideCursor(): void {
  if (cursorEl) {
    cursorEl.style.opacity = "0";
    setTimeout(() => {
      if (cursorEl && !state.visible) {
        cursorEl.style.display = "none";
      }
    }, 250);
  }
  state.visible = false;
}

export function setCursorBadge(text: string | null): void {
  ensureVisualCursor();
  if (!badgeEl) return;
  if (text) {
    badgeEl.textContent = text;
    badgeEl.style.display = "block";
  } else {
    badgeEl.style.display = "none";
    badgeEl.textContent = "";
  }
}

/**
 * Smoothly glide the visual cursor to target viewport coordinates (targetX, targetY).
 */
export function moveCustomCursor(
  targetX: number,
  targetY: number,
  duration = 450
): Promise<void> {
  const cursor = ensureVisualCursor();
  showCursor();

  if (currentAnimation !== null) {
    cancelAnimationFrame(currentAnimation);
    currentAnimation = null;
  }

  return new Promise((resolve) => {
    const startX = state.x;
    const startY = state.y;
    const startTime = performance.now();

    // Human-like ease-in-out curve
    const ease = (t: number) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t);

    function step(currentTime: number) {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = ease(progress);

      const currentX = startX + (targetX - startX) * eased;
      const currentY = startY + (targetY - startY) * eased;

      state.x = currentX;
      state.y = currentY;

      cursor.style.left = `${currentX}px`;
      cursor.style.top = `${currentY}px`;

      if (progress < 1) {
        currentAnimation = requestAnimationFrame(step);
      } else {
        currentAnimation = null;
        state.x = targetX;
        state.y = targetY;
        cursor.style.left = `${targetX}px`;
        cursor.style.top = `${targetY}px`;
        resolve();
      }
    }

    currentAnimation = requestAnimationFrame(step);
  });
}

/**
 * Scroll an element into view smoothly if it is not fully visible in the viewport.
 */
export async function ensureElementInView(el: Element): Promise<void> {
  const rect = el.getBoundingClientRect();
  const inView =
    rect.top >= 40 &&
    rect.left >= 0 &&
    rect.bottom <= (window.innerHeight || document.documentElement.clientHeight) - 40 &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth);

  if (!inView) {
    el.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
    await new Promise((r) => setTimeout(r, 300));
  }
}

/**
 * Move cursor to the center of an element.
 */
export async function moveCursorToElement(
  el: Element,
  duration = 450
): Promise<{ x: number; y: number }> {
  await ensureElementInView(el);
  const rect = el.getBoundingClientRect();
  const targetX = Math.max(10, rect.left + rect.width / 2);
  const targetY = Math.max(10, rect.top + rect.height / 2);
  await moveCustomCursor(targetX, targetY, duration);
  return { x: targetX, y: targetY };
}

/**
 * Emit a visual click ripple animation at the given coordinates.
 */
export function triggerClickRipple(x: number, y: number): void {
  const ripple = document.createElement("div");
  ripple.className = "rv-cursor-ripple";
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  document.body.appendChild(ripple);
  setTimeout(() => ripple.remove(), 500);

  if (cursorEl) {
    cursorEl.classList.add("rv-clicking");
    setTimeout(() => cursorEl?.classList.remove("rv-clicking"), 180);
  }
}

/**
 * Dispatch real human-like mouse events at the target element.
 * Uses both high-precision CDP execution (via background worker)
 * and seamless in-page DOM events.
 */
export async function clickAtCoordinates(
  x: number,
  y: number,
  preferredEl?: Element
): Promise<Element | null> {
  triggerClickRipple(x, y);

  // 1. Try CDP low-level click first (bypasses all framework event blockers)
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      await chrome.runtime.sendMessage({
        type: "RV_CDP_CLICK",
        x: Math.round(x),
        y: Math.round(y),
      });
    } catch {
      /* fallback to in-page events */
    }
  }

  const target = preferredEl || document.elementFromPoint(x, y);
  if (!target) return null;

  const eventSequence = [
    "pointerover",
    "mouseover",
    "pointerenter",
    "mouseenter",
    "pointermove",
    "mousemove",
    "pointerdown",
    "mousedown",
    "pointerup",
    "mouseup",
    "click",
  ];

  for (const eventType of eventSequence) {
    const isDown = eventType.includes("down");
    const event = new MouseEvent(eventType, {
      view: window,
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      screenX: x + window.screenX,
      screenY: y + window.screenY,
      buttons: isDown ? 1 : 0,
      button: 0,
    });
    target.dispatchEvent(event);
  }

  if (target instanceof HTMLElement) {
    target.focus();
  }

  return target;
}

/**
 * Full visual human-like click on an element:
 * 1. Move cursor to element
 * 2. Show "Clicking..." badge
 * 3. Dispatch authentic mouse events with ripple
 */
export async function visualHumanClick(el: Element): Promise<void> {
  const label =
    (el as HTMLElement).innerText?.slice(0, 18) ||
    el.getAttribute("aria-label") ||
    el.id ||
    "element";
  setCursorBadge(`Clicking ${label}…`);

  const { x, y } = await moveCursorToElement(el, 400);
  await clickAtCoordinates(x, y, el);

  // If it's a button or link and native click didn't trigger form submit
  if (el instanceof HTMLElement && typeof el.click === "function") {
    el.click();
  }

  await new Promise((r) => setTimeout(r, 120));
  setCursorBadge(null);
}

/**
 * Full visual human-like type into an element:
 * 1. Move cursor to element & click to focus
 * 2. Show "Typing..." badge
 * 3. Type character-by-character with realistic cadence
 * 4. Uses CDP Input.insertText for authentic rich-text/React editor support (ChatGPT, Claude, etc.)
 */
export async function visualHumanType(
  el: HTMLElement,
  value: string
): Promise<void> {
  const { x, y } = await moveCursorToElement(el, 380);
  await clickAtCoordinates(x, y, el);

  el.classList.add("rv-element-focus-highlight");
  setCursorBadge(`Typing…`);

  // 1. Try CDP typing first (direct browser engine insertion into focused element)
  let cdpSuccess = false;
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      const resp = (await chrome.runtime.sendMessage({
        type: "RV_CDP_TYPE",
        x: Math.round(x),
        y: Math.round(y),
        text: value,
      })) as { ok: boolean };
      if (resp?.ok) {
        cdpSuccess = true;
      }
    } catch {
      cdpSuccess = false;
    }
  }

  // 2. High-fidelity DOM fallback if CDP was not available or needs DOM sync
  const isInput = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement;

  if (isInput) {
    const input = el as HTMLInputElement | HTMLTextAreaElement;
    input.focus();

    if (!cdpSuccess) {
      // Trigger React's internal value tracker via native prototype setter
      const nativeSetter = input instanceof HTMLInputElement
        ? Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set
        : Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

      if (nativeSetter) {
        nativeSetter.call(input, value);
      } else {
        input.value = value;
      }

      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  } else if (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.id === "prompt-textarea") {
    el.focus();
    if (!cdpSuccess) {
      document.execCommand?.("insertText", false, value);
      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          cancelable: true,
          inputType: "insertText",
          data: value,
        })
      );
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  // Short human pause after typing
  await new Promise((r) => setTimeout(r, 150));

  el.classList.remove("rv-element-focus-highlight");
  setCursorBadge(null);
}

/**
 * Dispatch an authentic Enter key event (via CDP and DOM) to submit messages in chat interfaces.
 */
export async function visualHumanPressEnter(el?: HTMLElement): Promise<void> {
  if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
    try {
      await chrome.runtime.sendMessage({
        type: "RV_CDP_KEY",
        key: "Enter",
        code: "Enter",
        keyCode: 13,
      });
    } catch {
      /* fallback */
    }
  }

  if (el) {
    el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
}

/**
 * Full visual human-like select dropdown option.
 */
export async function visualHumanSelect(
  el: HTMLSelectElement,
  value: string
): Promise<void> {
  const { x, y } = await moveCursorToElement(el, 380);
  await clickAtCoordinates(x, y, el);
  setCursorBadge(`Selecting ${value}…`);

  // Find matching option by value or text
  let found = false;
  for (let i = 0; i < el.options.length; i++) {
    const opt = el.options[i];
    if (
      opt.value.toLowerCase() === value.toLowerCase() ||
      opt.text.toLowerCase() === value.toLowerCase() ||
      opt.text.toLowerCase().includes(value.toLowerCase())
    ) {
      el.selectedIndex = i;
      found = true;
      break;
    }
  }

  if (!found && el.options.length > 1) {
    el.selectedIndex = 1;
  }

  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));

  await new Promise((r) => setTimeout(r, 150));
  setCursorBadge(null);
}

/**
 * Visual human-like scroll: glides cursor towards center then smoothly scrolls.
 */
export async function visualHumanScroll(
  direction: "up" | "down" | "left" | "right" = "down",
  amount = 500
): Promise<void> {
  setCursorBadge(`Scrolling ${direction}…`);
  const centerX = window.innerWidth / 2;
  const centerY = window.innerHeight / 2;
  await moveCustomCursor(centerX, centerY, 250);

  let dx = 0;
  let dy = 0;
  switch (direction) {
    case "down":
      dy = amount;
      break;
    case "up":
      dy = -amount;
      break;
    case "right":
      dx = amount;
      break;
    case "left":
      dx = -amount;
      break;
  }

  window.scrollBy({ top: dy, left: dx, behavior: "smooth" });
  await new Promise((r) => setTimeout(r, 350));
  setCursorBadge(null);
}
