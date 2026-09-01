/**
 * RedactVision Agent - Action Executor
 *
 * Browser action execution with validation, execution, and result reporting.
 * Supports: click, type, scroll, select, wait.
 * Privacy: Type values may be tokens like [EMAIL_01] which are resolved
 * locally using the PrivacyFirewall's token map.
 */

import { PrivacyFirewall } from "../privacy/privacy-firewall";
import {
  parseProfileToken,
  resolveTokenFromProfiles,
  type LocalProfileValues,
} from "../privacy/profile-store";
import {
  visualHumanClick,
  visualHumanType,
  visualHumanSelect,
  visualHumanScroll,
  visualHumanPressEnter,
  hideCursor,
} from "./visual-cursor";
import {
  handleFallbackVisualClick,
  handleFallbackVisualType,
} from "./visual-grounding";
import { SelectorCache } from "./selector-cache";

type TypeTarget = HTMLInputElement | HTMLTextAreaElement | HTMLElement;

export type ActionType = "click" | "type" | "scroll" | "select" | "wait" | "navigate" | "open_tab" | "fanout";

export interface PlannedAction {
  action: ActionType;
  target?: string;
  value?: string;
  direction?: "up" | "down" | "left" | "right";
  amount?: number;
  confidence: number;
  reasoning?: string;
}

export interface ActionResult {
  success: boolean;
  action: PlannedAction;
  message: string;
  durationMs: number;
}

/**
 * Signal that the executor needs the user to supply a value.
 * The field could not be resolved from:
 *   1. page-local token map
 *   2. session profile (auto-extracted from user prompt)
 *   3. selected saved profile
 *
 * When this is returned (instead of success:false), the agent session
 * pauses the loop, shows a "missing_info" activity in the chat, and
 * waits for the user's next message. The session extracts the value
 * from that message and retries the action.
 */
export interface AskUserInfo extends Record<string, unknown> {
  /** e.g. "email", "phone", "pan_card", "application_id" */
  field: string;
  /** Filled profiles that have this field (user can choose from these) */
  candidates: Array<{
    profileId: string;
    profileLabel: string;
    masked: string;
  }>;
}

export type ExecuteResult = ActionResult | { askUser: AskUserInfo; action: PlannedAction };

export interface ExecutorContext {
  privacyFirewall: PrivacyFirewall;
  sessionProfile?: () => LocalProfileValues | null;
}

export class ActionExecutor {
  private context: ExecutorContext;

  constructor(context: ExecutorContext) {
    this.context = context;
  }

  /**
   * Validate action schema and target against current page.
   *
   * The real browser is noisier than tidy test selectors, so for type
   * actions we also allow a semantic fallback when a raw selector does
   * not match the current DOM but the field is clearly identifiable by
   * label/id/name semantics.
   */
  validate(action: PlannedAction): { valid: boolean; reason?: string } {
    // Schema check
    const allowed: ActionType[] = ["click", "type", "scroll", "select", "wait", "navigate", "open_tab", "fanout"];
    if (!allowed.includes(action.action)) {
      return { valid: false, reason: `Unsupported action: ${action.action}` };
    }

    // Confidence threshold
    if (action.confidence < 0.5) {
      return { valid: false, reason: `Confidence too low: ${action.confidence.toFixed(2)}` };
    }

    // Target required for click/type/select
    if ((action.action === "click" || action.action === "type" || action.action === "select") && !action.target) {
      return { valid: false, reason: `Action ${action.action} requires a target` };
    }

    // Type requires a value field. Note: we reject only the
    // `undefined` case — an empty string ("") is a legitimate
    // "clear the input" action and must pass validation.
    if (action.action === "type" && action.value === undefined) {
      return { valid: false, reason: "Type action missing a value field" };
    }

    return { valid: true };
  }

  /**
   * Execute an action and return the result.
   * May return an "ask user" signal when a token cannot be resolved.
   */
  async execute(action: PlannedAction): Promise<ExecuteResult> {
    const start = performance.now();

    // Pre-validate
    const validation = this.validate(action);
    if (!validation.valid) {
      return {
        success: false,
        action,
        message: validation.reason || "Validation failed",
        durationMs: 0,
      };
    }

    try {
      let message = "";
      switch (action.action) {
        case "click":
          message = await this.executeClick(action);
          break;
        case "type": {
          const result = await this.executeType(action);
          if ("askUser" in result) {
            const durationMs = performance.now() - start;
            return { askUser: result.askUser, action, durationMs };
          }
          message = result.message;
          break;
        }
        case "scroll":
          message = await this.executeScroll(action);
          break;
        case "select":
          message = await this.executeSelect(action);
          break;
        case "wait":
          message = await this.executeWait(action);
          break;
        case "navigate":
        case "open_tab":
          message = await this.executeNavigate(action);
          break;
        default:
          message = `Unknown action: ${(action as PlannedAction).action}`;
      }

      const durationMs = performance.now() - start;
      return { success: true, action, message, durationMs };
    } catch (err) {
      const durationMs = performance.now() - start;
      const errMsg = err instanceof Error ? err.message : String(err);
      return { success: false, action, message: `Execution error: ${errMsg}`, durationMs };
    }
  }

  private async executeClick(action: PlannedAction): Promise<string> {
    // 1. Check fast-path selector cache
    const targetKey = action.target || "";
    const cachedEl = SelectorCache.get(targetKey);
    const el = cachedEl || document.querySelector(targetKey) || this.findSemanticTarget(action);

    if (el && el instanceof HTMLElement) {
      if (targetKey) SelectorCache.set(targetKey, action.target!);
      await visualHumanClick(el);

      // If clicking a send/submit button on a chat interface, also dispatch Enter on the chat box
      const isSendBtn = /send|submit|arrow/i.test([action.target, el.getAttribute("aria-label"), el.id, el.className].join(" "));
      if (isSendBtn) {
        const inputEl = document.querySelector<HTMLElement>("textarea, [contenteditable='true'], input");
        await visualHumanPressEnter(inputEl || el);
      }

      return `Clicked ${action.target}`;
    }

    // Step 5: Multimodal VLM Visual Fallback (CDP + Screenshot Grounding)
    const targetDesc = action.target || action.reasoning || "target button";
    const visualSuccess = await handleFallbackVisualClick(targetDesc);
    if (visualSuccess) {
      return `Visually located and clicked ${action.target ?? "element"}`;
    }

    throw new Error(`Target not found in DOM or visual scan: ${action.target ?? "unknown"}`);
  }

  /**
   * Execute a type action. Returns either the success message or an
   * AskUserInfo signal when the value token cannot be resolved.
   */
  private async executeType(
    action: PlannedAction
  ): Promise<{ message: string } | { askUser: AskUserInfo }> {
    // `action.value` is guaranteed to be defined by validate(), but
    // we still coalesce to "" for safety.
    let value = action.value ?? "";

    // Handle "Press Enter" action emitted by models attempting to submit/send
    const isEnterAction =
      value === "\n" ||
      value === "\r\n" ||
      value === "Enter" ||
      (value.trim() === "" && action.reasoning && /press\s*enter|send\s*(?:the\s*)?message|submit/i.test(action.reasoning));

    if (isEnterAction) {
      const el = this.resolveTypeTarget(action);
      const targetEl = (el || document.activeElement || document.querySelector("textarea, input, [contenteditable='true']")) as HTMLElement;
      await visualHumanPressEnter(targetEl);
      return { message: `Pressed Enter to send message in ${action.target ?? "chat"}` };
    }

    if (isLocalToken(value)) {
      // Token reference — resolve locally in priority order:
      // 1. page-local privacy token map (if value was on the page)
      // 2. session profile (auto-extracted from user prompt)
      // 3. selected saved profile (from browser storage)
      let resolved = this.context.privacyFirewall.resolveToken(value);
      if (resolved) {
        value = resolved;
      } else {
        // Try session profile (auto-extracted data)
        const sessionProfile = this.context.sessionProfile?.();
        if (sessionProfile) {
          resolved = this.resolveTokenFromSessionProfile(value, sessionProfile);
          if (resolved) {
            value = resolved;
          }
        }

        // Fall back to saved profile
        if (!resolved) {
          const profileResolved = await resolveTokenFromProfiles(value);
          if (profileResolved.value) {
            value = profileResolved.value;
          } else {
            // Cannot resolve → signal "ask user" so the agent pauses
            // and requests the value in the chat.
            const field =
              parseProfileToken(value) ||
              legacyTokenToField(value) ||
              value.replace(/^\[|\]$/g, "");
            return {
              askUser: {
                field,
                candidates: profileResolved.candidates,
              },
            };
          }
        }
      }
    }

    const display = isLocalToken(action.value ?? "")
      ? "(resolved)"
      : `${value.length} char${value.length === 1 ? "" : "s"}`;

    const el = this.resolveTypeTarget(action);
    if (el && isTypeTarget(el)) {
      await visualHumanType(el, value);
      return { message: `Typed ${display} into ${action.target ?? "matched field"}` };
    }

    // Step 5: Multimodal VLM Visual Fallback (CDP + Screenshot Grounding)
    const targetDesc = action.target || action.reasoning || "input field";
    const visualSuccess = await handleFallbackVisualType(targetDesc, value);
    if (visualSuccess) {
      return { message: `Visually typed ${display} into ${action.target ?? "field"}` };
    }

    throw new Error(`Target not found in DOM or visual scan: ${action.target ?? "unknown"}`);
  }

  /**
   * Resolve a token using a session profile (auto-extracted from user prompt).
   */
  private resolveTokenFromSessionProfile(
    token: string,
    profile: LocalProfileValues
  ): string | null {
    const field = parseProfileToken(token) || legacyTokenToField(token);
    if (field && profile[field]) {
      return profile[field];
    }
    return null;
  }

  private typeIntoElement(el: TypeTarget, value: string): void {
    el.focus();

    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      el.value = value;
      el.setSelectionRange(el.value.length, el.value.length);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }

    const inserted = document.execCommand?.("insertText", false, value);
    if (!inserted) {
      el.textContent = value;
    }
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  }

  private resolveTypeTarget(action: PlannedAction): TypeTarget | null {
    const targetKey = action.target || "";

    // 1. Check fast-path selector cache
    if (targetKey) {
      const cached = SelectorCache.get(targetKey);
      if (cached && isTypeTarget(cached)) {
        return cached;
      }
    }

    const direct = targetKey ? document.querySelector(targetKey) : null;
    if (isTypeTarget(direct)) {
      if (targetKey) SelectorCache.set(targetKey, targetKey);
      return direct;
    }

    // Try to detect the field type from the server-planned target selector.
    // If we find a matching element, also read its label text for a richer signal.
    const fieldType = this.detectFieldType(action);

    let bestCandidate: TypeTarget | null = null;
    let bestScore = -1;

    for (const el of document.querySelectorAll<TypeTarget>('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
      const labelText = this.getLabelText(el);
      // Detect the field type from THIS element's label — not the server's hint.
      // This makes detection dynamic: the server knows "type X into #f3", and we
      // figure out what #f3 means by reading "Government ID / PAN" from the label.
      const elementFieldType = this.detectFieldType(action, labelText) || fieldType || "text";

      const haystack = [
        labelText,   // highest priority: label text says what the field is
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.getAttribute("autocomplete"),
        el.id,
        getElementName(el),
        getElementType(el),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();

      const score = this.scoreFieldMatch(haystack, elementFieldType);
      if (score > bestScore) {
        bestScore = score;
        bestCandidate = el;
      }
    }

    if (bestCandidate) {
      if (targetKey && (bestCandidate.id || bestCandidate.getAttribute("name"))) {
        SelectorCache.set(targetKey, bestCandidate.id ? `#${CSS.escape(bestCandidate.id)}` : `[name="${bestCandidate.getAttribute('name')}"]`);
      }
      return bestCandidate;
    }

    // Fallback: if active element is an editable field, use it
    if (document.activeElement && isTypeTarget(document.activeElement)) {
      return document.activeElement as TypeTarget;
    }

    // Fallback: first visible editable textarea or input
    const allInputs = document.querySelectorAll<TypeTarget>('textarea, input:not([type="hidden"]):not([type="submit"]):not([type="button"]), [contenteditable="true"]');
    for (const el of allInputs) {
      if ((el as HTMLElement).offsetParent !== null) {
        return el;
      }
    }

    return null;
  }

  /**
   * Determine the kind of data expected by a form field, using BOTH the
   * server-planned action metadata AND the field's actual label text.
   *
   * The label text is the primary signal — not the field's name/id/placeholder
   * attributes. This lets the agent handle ANY form with ANY field label
   * without hardcoding patterns.
   */
  private detectFieldType(
    action: PlannedAction,
    labelText?: string | null
  ): "name" | "email" | "phone" | "password" | "address" | "text" | null {
    // Combine server-side hints with the field's real label text.
    const serverHint = [action.target ?? "", action.value ?? ""].join(" ").toLowerCase();
    // labelText comes from the DOM — the source of truth for what the field asks.
    const labelHint = (labelText ?? "").toLowerCase();
    const combined = `${serverHint} ${labelHint}`;

    if (/email|e-mail/.test(combined)) return "email";
    if (/phone|mobile|telephone|tel|contact\s*number/.test(combined)) return "phone";
    if (/password|passcode|pass\s*word/.test(combined)) return "password";
    if (/address|city|location|street/.test(combined)) return "address";
    if (/name|full\s*name|fullname|first\s*name|last\s*name|applicant\s*name/.test(combined)) return "name";
    if (labelHint.length > 0) return "text"; // non-specific field — use placeholder/default
    return null;
  }

  private scoreFieldMatch(haystack: string, fieldType: "name" | "email" | "phone" | "password" | "address" | "text"): number {
    const patterns: Record<string, RegExp[]> = {
      name: [/full\s*name/, /first\s*name/, /last\s*name/, /applicant\s*name/, /name/],
      email: [/email/, /e-?mail/],
      phone: [/phone/, /mobile/, /telephone/, /tel/, /contact\s*number/],
      password: [/password/, /passcode/, /pass\s*word/],
      address: [/address/, /city/, /location/, /street/, /zip/],
      text: [], // "text" is a catch-all for generic fields — always match
    };

    const fieldPatterns = patterns[fieldType];
    if (!fieldPatterns) return 0;

    let score = 0;
    for (const pattern of fieldPatterns) {
      if (pattern.test(haystack)) score += 20;
    }
    return score;
  }

  private getLabelText(el: TypeTarget): string {
    const id = el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    if (id) return id.textContent || "";

    const parent = el.closest("label");
    if (parent) return parent.textContent || "";

    const formGroup = el.closest("div, section, fieldset");
    if (formGroup) {
      const label = formGroup.querySelector("label");
      if (label) return label.textContent || "";
    }

    return "";
  }

  private findSemanticTarget(action: PlannedAction): Element | null {
    const candidates = document.querySelectorAll<TypeTarget>(
      'input, textarea, [contenteditable="true"], [contenteditable=""]'
    );
    let best: Element | null = null;
    let bestScore = -1;

    for (const el of candidates) {
      const labelText = this.getLabelText(el);
      // Use the element's label to determine type dynamically — no hardcoding.
      const type = this.detectFieldType(action, labelText);
      if (!type) continue;

      const haystack = [
        labelText,
        el.getAttribute("placeholder"),
        el.getAttribute("aria-label"),
        el.id,
        getElementName(el),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      const score = this.scoreFieldMatch(haystack, type);
      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  private async executeScroll(action: PlannedAction): Promise<string> {
    const amount = action.amount ?? 500;
    const direction = action.direction ?? "down";
    await visualHumanScroll(direction, amount);
    return `Scrolled ${direction} ${amount}px`;
  }

  private async executeSelect(action: PlannedAction): Promise<string> {
    const el = document.querySelector(action.target!) || this.findSemanticTarget(action);
    if (!el) throw new Error("Target not found");
    if (!(el instanceof HTMLSelectElement)) {
      throw new Error("Target is not a select element");
    }

    const value = action.value || "";
    await visualHumanSelect(el, value);
    return `Selected "${value}" in ${action.target}`;
  }

  private async executeWait(action: PlannedAction): Promise<string> {
    const amount = action.amount ?? 500;
    await new Promise((r) => setTimeout(r, amount));
    return `Waited ${amount}ms`;
  }

  private async executeNavigate(action: PlannedAction): Promise<string> {
    const targetUrl = action.target || action.value || "";
    if (!targetUrl) throw new Error("Navigation requires a target URL");

    const fullUrl = targetUrl.startsWith("http") ? targetUrl : `https://${targetUrl}`;

    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      if (action.action === "open_tab") {
        await chrome.runtime.sendMessage({
          type: "RV_OPEN_TAB",
          url: fullUrl,
          active: true,
        });
        return `Opened new tab: ${fullUrl}`;
      } else {
        await chrome.runtime.sendMessage({
          type: "RV_NAVIGATE_TAB",
          url: fullUrl,
        });
        return `Navigated to ${fullUrl}`;
      }
    }

    window.location.href = fullUrl;
    return `Navigated to ${fullUrl}`;
  }
}

function isLocalToken(value: string): boolean {
  return /^\[[A-Z_]+_\d+\]$/.test(value) || parseProfileToken(value) !== null;
}

function isTypeTarget(el: Element | null): el is TypeTarget {
  return (
    el instanceof HTMLInputElement ||
    el instanceof HTMLTextAreaElement ||
    (el instanceof HTMLElement && (el.isContentEditable || el.getAttribute("contenteditable") === "true" || el.getAttribute("role") === "textbox"))
  );
}

function getElementName(el: TypeTarget): string | null {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    return el.name || el.getAttribute("name");
  }
  return el.getAttribute("name");
}

function getElementType(el: TypeTarget): string | null {
  if (el instanceof HTMLInputElement) return el.type || el.getAttribute("type");
  if (el instanceof HTMLTextAreaElement) return "textarea";
  return el.getAttribute("type") || (el.isContentEditable ? "contenteditable" : null);
}

function legacyTokenToField(token: string): string | null {
  const match = token.match(/^\[([A-Z_]+)_\d+\]$/);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  if (raw === "person") return "name";
  if (raw === "card") return "card";
  return raw;
}
