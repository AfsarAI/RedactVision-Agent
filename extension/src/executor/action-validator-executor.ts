/**
 * RedactVision Agent - Action Executor with Validation & Policy Engine
 *
 * Validates and executes server-generated actions locally.
 * Ensures all actions meet security/privacy policy before browser execution.
 * Resolves tokens back to original values when needed (e.g., for form filling).
 *
 * Privacy contract:
 * - Validate schema before execution
 * - Check target existence and visibility
 * - Enforce policy restrictions
 * - Only resolve tokens locally (server never sees originals)
 * - Log actions (no sensitive values)
 */

import { SensitiveDataMapManager } from "../perception/sensitive-data-map";

export type ActionType = "click" | "type" | "scroll" | "navigate" | "wait";

export interface ServerAction {
  /** Type of action */
  action: ActionType;
  /** Target selector or semantic description */
  target: string;
  /** Server's confidence in this action (0-1) */
  confidence: number;
  /** Value for "type" actions (may contain tokens like [EMAIL_01]) */
  value?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

export interface ActionValidationResult {
  /** Whether the action passed validation */
  valid: boolean;
  /** Validation issues (if any) */
  issues: string[];
  /** Risk level: "safe" | "medium" | "high" */
  riskLevel: "safe" | "medium" | "high";
  /** Whether user confirmation is required */
  requiresConfirmation: boolean;
}

export interface ExecutionResult {
  /** Whether execution succeeded */
  success: boolean;
  /** Result message or error */
  message: string;
  /** Time taken (ms) */
  executionTimeMs: number;
}

/**
 * Action validator with security/privacy policy.
 */
export class ActionValidator {
  /** Confidence threshold below which actions are rejected */
  private minConfidenceThreshold = 0.5;

  /** Actions that require explicit user confirmation */
  private highRiskActions: ActionType[] = ["navigate"];

  /** Selectors that are considered safe (open-list approach) */
  private safeSelectors = new Set<string>();

  constructor(minConfidenceThreshold: number = 0.5) {
    this.minConfidenceThreshold = minConfidenceThreshold;
  }

  /**
   * Validate an action before execution.
   */
  validate(action: ServerAction): ActionValidationResult {
    const issues: string[] = [];
    let riskLevel: "safe" | "medium" | "high" = "safe";

    // Check confidence
    if (action.confidence < this.minConfidenceThreshold) {
      issues.push(
        `Confidence ${action.confidence.toFixed(2)} is below threshold ${this.minConfidenceThreshold}`
      );
      riskLevel = "high";
    }

    // Validate action type
    if (!["click", "type", "scroll", "navigate", "wait"].includes(action.action)) {
      issues.push(`Unknown action type: ${action.action}`);
      riskLevel = "high";
    }

    // Validate target
    if (!action.target || action.target.trim().length === 0) {
      issues.push("Target is empty or missing");
      riskLevel = "high";
    }

    // Type-specific validation
    switch (action.action) {
      case "type":
        if (!action.value) {
          issues.push("Type action missing value");
          riskLevel = "high";
        }
        // Check for obvious injection patterns
        if (action.value && action.value.includes("<script>")) {
          issues.push("Detected potential script injection in value");
          riskLevel = "high";
        }
        break;

      case "navigate":
        // Navigation is inherently risky
        riskLevel = "high";
        if (!this.isValidURL(action.value)) {
          issues.push("Invalid or unsafe URL for navigation");
          riskLevel = "high";
        }
        break;

      case "scroll":
        // Low risk, but check for sane values
        const scrollValue = action.metadata?.amount || "down";
        if (!["up", "down", "left", "right"].includes(String(scrollValue))) {
          issues.push("Invalid scroll direction");
          riskLevel = "medium";
        }
        break;

      case "click":
        // Click is low risk, but target must be findable
        if (!this.isValidSelector(action.target)) {
          issues.push("Target selector format is invalid");
          riskLevel = "medium";
        }
        break;

      case "wait":
        const waitTime = action.metadata?.ms || 1000;
        if (typeof waitTime !== "number" || waitTime < 0 || waitTime > 30000) {
          issues.push(`Invalid wait time: ${waitTime}. Must be 0-30000ms`);
          riskLevel = "medium";
        }
        break;
    }

    const requiresConfirmation = riskLevel === "high" || this.highRiskActions.includes(action.action);

    return {
      valid: issues.length === 0,
      issues,
      riskLevel,
      requiresConfirmation,
    };
  }

  /**
   * Check if a selector looks valid.
   */
  private isValidSelector(target: string): boolean {
    // Accept CSS selectors and semantic descriptions
    return (
      target.length > 0 &&
      target.length < 500 && // Reasonable limit
      !target.includes("<") && // No HTML tags
      !target.includes(">") // No comparisons
    );
  }

  /**
   * Check if a URL is safe to navigate to.
   */
  private isValidURL(url: string | undefined): boolean {
    if (!url) return false;

    try {
      const parsed = new URL(url, window.location.href);

      // Only allow http/https
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return false;
      }

      // Warn about different domain (but allow)
      if (parsed.origin !== window.location.origin) {
        console.warn(`[ActionValidator] Cross-origin navigation to: ${parsed.origin}`);
      }

      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Action executor that performs validated actions in the browser.
 */
export class ActionExecutor {
  private validator: ActionValidator;
  private tokenMap: SensitiveDataMapManager | null = null;
  private actionLog: Array<{ action: ServerAction; result: string; timestamp: number }> = [];

  constructor(validator?: ActionValidator) {
    this.validator = validator || new ActionValidator();
  }

  /**
   * Set the token map for resolution (needed for "type" actions with tokens).
   */
  setTokenMap(tokenMap: SensitiveDataMapManager): void {
    this.tokenMap = tokenMap;
  }

  /**
   * Execute a validated action.
   */
  async execute(action: ServerAction): Promise<ExecutionResult> {
    const startTime = performance.now();

    // Validate first
    const validation = this.validator.validate(action);
    if (!validation.valid) {
      const message = `Validation failed: ${validation.issues.join("; ")}`;
      console.error(`[ActionExecutor] ${message}`);

      this.actionLog.push({
        action,
        result: `FAILED: ${message}`,
        timestamp: Date.now(),
      });

      return {
        success: false,
        message,
        executionTimeMs: performance.now() - startTime,
      };
    }

    console.log(`[ActionExecutor] Executing ${action.action} action on target: ${action.target}`);

    try {
      let result: string;

      switch (action.action) {
        case "click":
          result = await this.executeClick(action.target);
          break;

        case "type":
          const value = await this.resolveValue(action.value);
          result = await this.executeType(action.target, value);
          break;

        case "scroll":
          const direction = String(action.metadata?.amount || "down");
          result = await this.executeScroll(direction);
          break;

        case "navigate":
          result = await this.executeNavigate(action.value || "");
          break;

        case "wait":
          const ms = Number(action.metadata?.ms || 1000);
          result = await this.executeWait(ms);
          break;

        default:
          result = `Unknown action type: ${action.action}`;
      }

      const executionTimeMs = performance.now() - startTime;

      this.actionLog.push({
        action,
        result,
        timestamp: Date.now(),
      });

      console.log(`[ActionExecutor] Action completed: ${result} (${executionTimeMs.toFixed(2)}ms)`);

      return {
        success: true,
        message: result,
        executionTimeMs,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const executionTimeMs = performance.now() - startTime;

      this.actionLog.push({
        action,
        result: `ERROR: ${message}`,
        timestamp: Date.now(),
      });

      console.error(`[ActionExecutor] Execution failed:`, message);

      return {
        success: false,
        message,
        executionTimeMs,
      };
    }
  }

  /**
   * Execute a click action.
   */
  private async executeClick(target: string): Promise<string> {
    // Try CSS selector first
    let element: Element | null = null;

    try {
      element = document.querySelector(target);
    } catch {
      // Not a valid CSS selector, try other methods
    }

    // Try by text content if selector failed
    if (!element) {
      const elements = Array.from(document.querySelectorAll("button, a, input[type='submit']"));
      const found = elements.find((el) => el.textContent?.toLowerCase().includes(target.toLowerCase()));
      element = found || null;
    }

    if (!element) {
      throw new Error(`Target not found: ${target}`);
    }

    // Check visibility
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) {
      throw new Error(`Target not visible: ${target}`);
    }

    (element as HTMLElement).click();
    return `Clicked element matching target: ${target}`;
  }

  /**
   * Execute a type action.
   */
  private async executeType(target: string, value: string): Promise<string> {
    let element: Element | null = null;

    try {
      element = document.querySelector(target);
    } catch {
      // Not a valid CSS selector
    }

    if (!element) {
      const inputs = Array.from(document.querySelectorAll("input, textarea"));
      const found = inputs.find((el) => {
        const input = el as HTMLInputElement;
        return (
          input.placeholder?.toLowerCase().includes(target.toLowerCase()) ||
          (el as HTMLElement).textContent?.toLowerCase().includes(target.toLowerCase())
        );
      });
      element = found || null;
    }

    if (!element) {
      throw new Error(`Target input not found: ${target}`);
    }

    const input = element as HTMLInputElement & HTMLTextAreaElement;

    // Clear existing value
    input.value = "";

    // Type the value character by character (simulates user input)
    for (const char of value) {
      input.value += char;

      // Trigger input events
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));

      // Small delay between characters
      await new Promise((resolve) => setTimeout(resolve, 10));
    }

    return `Typed ${value.length} characters into element: ${target}`;
  }

  /**
   * Execute a scroll action.
   */
  private async executeScroll(direction: string): Promise<string> {
    const scrollAmount = 300; // pixels

    switch (direction.toLowerCase()) {
      case "down":
        window.scrollBy(0, scrollAmount);
        break;
      case "up":
        window.scrollBy(0, -scrollAmount);
        break;
      case "left":
        window.scrollBy(-scrollAmount, 0);
        break;
      case "right":
        window.scrollBy(scrollAmount, 0);
        break;
      default:
        throw new Error(`Invalid scroll direction: ${direction}`);
    }

    await new Promise((resolve) => setTimeout(resolve, 300)); // Wait for scroll animation
    return `Scrolled ${direction} by ${scrollAmount}px`;
  }

  /**
   * Execute a navigate action.
   */
  private async executeNavigate(url: string): Promise<string> {
    try {
      const parsed = new URL(url, window.location.href);
      window.location.href = parsed.href;
      return `Navigating to: ${parsed.href}`;
    } catch (error) {
      throw new Error(`Invalid URL: ${url}`);
    }
  }

  /**
   * Execute a wait action.
   */
  private async executeWait(ms: number): Promise<string> {
    await new Promise((resolve) => setTimeout(resolve, ms));
    return `Waited ${ms}ms`;
  }

  /**
   * Resolve tokens in a value (e.g., [EMAIL_01] → original email).
   * This happens entirely locally.
   */
  private async resolveValue(value: string | undefined): Promise<string> {
    if (!value) return "";

    if (!this.tokenMap) {
      // No token map, return as-is
      return value;
    }

    let resolved = value;
    const tokenPattern = /\[([A-Z_]+_\d+)\]/g;

    for (const match of value.matchAll(tokenPattern)) {
      const token = match[0];
      const originalValue = this.tokenMap.resolveToken(token);

      if (originalValue) {
        resolved = resolved.replace(token, originalValue);
        console.log(`[ActionExecutor] Resolved token ${token} locally (original value protected)`);
      }
    }

    return resolved;
  }

  /**
   * Get action log (no sensitive values).
   */
  getActionLog(): Array<{ action: string; result: string; timestamp: number }> {
    return this.actionLog.map((entry) => ({
      action: entry.action.action,
      result: entry.result,
      timestamp: entry.timestamp,
    }));
  }
}

/**
 * Simple action executor factory for common use cases.
 */
export function createActionExecutor(minConfidence?: number): ActionExecutor {
  const validator = new ActionValidator(minConfidence);
  return new ActionExecutor(validator);
}
