/**
 * RedactVision Agent - Action Executor
 *
 * Browser action execution with validation, execution, and result reporting.
 * Supports: click, type, scroll, select, wait.
 * Privacy: Type values may be tokens like [EMAIL_01] which are resolved
 * locally using the PrivacyFirewall's token map.
 */

import { PrivacyFirewall } from "../privacy/privacy-firewall";

export type ActionType = "click" | "type" | "scroll" | "select" | "wait" | "navigate";

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

export interface ExecutorContext {
  privacyFirewall: PrivacyFirewall;
}

export class ActionExecutor {
  private context: ExecutorContext;

  constructor(context: ExecutorContext) {
    this.context = context;
  }

  /**
   * Validate action schema and target against current page.
   */
  validate(action: PlannedAction): { valid: boolean; reason?: string } {
    // Schema check
    const allowed: ActionType[] = ["click", "type", "scroll", "select", "wait", "navigate"];
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

    // Target existence check
    if (action.target) {
      const el = document.querySelector(action.target);
      if (!el) {
        return { valid: false, reason: `Target not found in DOM: ${action.target}` };
      }
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
   */
  async execute(action: PlannedAction): Promise<ActionResult> {
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
        case "type":
          message = await this.executeType(action);
          break;
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
          message = "Navigation not auto-executed (policy)";
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
    const el = document.querySelector(action.target!);
    if (!el) throw new Error("Target not found");
    if (!(el instanceof HTMLElement)) throw new Error("Target is not an HTMLElement");

    el.click();
    return `Clicked ${action.target}`;
  }

  private async executeType(action: PlannedAction): Promise<string> {
    const el = document.querySelector(action.target!);
    if (!el) throw new Error("Target not found");
    if (!(el instanceof HTMLInputElement) && !(el instanceof HTMLTextAreaElement)) {
      throw new Error("Target is not an input/textarea");
    }

    // `action.value` is guaranteed to be defined by validate(), but
    // we still coalesce to "" for safety.
    let value = action.value ?? "";

    let display = "";
    if (/^\[[A-Z_]+_\d+\]$/.test(value)) {
      // Token reference — resolve locally and report which token it was.
      const resolved = this.context.privacyFirewall.resolveToken(value);
      if (resolved) {
        value = resolved;
        display = `token ${value}`;
      } else {
        throw new Error(`Token not in local map: ${value}`);
      }
    } else {
      // Literal value — show the length, never the value itself
      // (avoids logging sensitive content).
      display = `${value.length} char${value.length === 1 ? "" : "s"}`;
    }

    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Typed ${display} into ${action.target}`;
  }

  private async executeScroll(action: PlannedAction): Promise<string> {
    const amount = action.amount ?? 500;
    const direction = action.direction ?? "down";

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
    return `Scrolled ${direction} ${amount}px`;
  }

  private async executeSelect(action: PlannedAction): Promise<string> {
    const el = document.querySelector(action.target!);
    if (!el) throw new Error("Target not found");
    if (!(el instanceof HTMLSelectElement)) {
      throw new Error("Target is not a select element");
    }

    const value = action.value || "";
    let found = false;
    for (const opt of Array.from(el.options)) {
      if (opt.value === value || opt.text.toLowerCase().includes(value.toLowerCase())) {
        el.value = opt.value;
        found = true;
        break;
      }
    }
    if (!found) throw new Error(`Option not found: ${value}`);
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return `Selected "${value}" in ${action.target}`;
  }

  private async executeWait(action: PlannedAction): Promise<string> {
    const amount = action.amount ?? 500;
    await new Promise((r) => setTimeout(r, amount));
    return `Waited ${amount}ms`;
  }
}
