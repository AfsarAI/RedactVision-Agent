/**
 * RedactVision Agent - Session / Agent Loop (LLM-backed)
 *
 * A session maintains:
 *  - conversation history (user prompts + agent activities)
 *  - action history (planned + executed actions)
 *  - per-task state machine
 *
 * For each user prompt, the session runs a multi-iteration loop:
 *   perceive → privacy → plan (via LLM) → validate → execute → verify
 *   if !done: re-perceive → re-plan → …  (up to MAX_ITERATIONS)
 *
 * One session supports multiple sequential user prompts.
 */

import type { PlannedAction, ActionResult } from "../executor/action-executor";
import { ActionExecutor } from "../executor/action-executor";
import { PlanningContext } from "./action-planner";
import { LLMPlanner, PlannerConfig, PlannerResult } from "../llm/llm-planner";
import { ActionHistoryEntry } from "../llm/action-schema";
import { extractPageDOM } from "../content/dom-extractor";
import { PrivacyFirewall } from "../privacy/privacy-firewall";
import type { SanitizedPageDOM } from "../privacy/privacy-types";

const DEFAULT_MAX_ITERATIONS = 5;

export type AgentActivityKind =
  | "user"
  | "stage"
  | "llm_thinking"
  | "action_planned"
  | "action_validated"
  | "action_executed"
  | "action_rejected"
  | "iteration_complete"
  | "error"
  | "info";

export interface AgentActivity {
  id: string;
  kind: AgentActivityKind;
  text: string;
  detail?: string;
  timestamp: number;
  meta?: Record<string, unknown>;
}

/** Compact privacy summary the UI uses to render the redaction card. */
export interface RedactionSummary {
  count: number;
  byType: Record<string, number>;
  inProgress?: boolean;
}

export interface AgentSessionCallbacks {
  onActivity?: (activity: AgentActivity) => void;
  /** Fires after each planner call. Useful for UI elements like the
   *  backend badge in the header. */
  onPlanResult?: (result: PlannerResult) => void;
}

export class AgentSession {
  private activities: AgentActivity[] = [];
  private actionHistory: Array<{
    prompt: string;
    action: PlannedAction;
    result?: ActionResult;
  }> = [];
  private callbacks: AgentSessionCallbacks;
  private privacyFirewall: PrivacyFirewall;
  private executor: ActionExecutor;
  private llmPlanner: LLMPlanner;
  private cancelled = false;
  private maxIterations: number;

  constructor(
    callbacks: AgentSessionCallbacks = {},
    plannerConfig?: PlannerConfig
  ) {
    this.callbacks = callbacks;
    this.privacyFirewall = new PrivacyFirewall();
    this.executor = new ActionExecutor({ privacyFirewall: this.privacyFirewall });
    this.llmPlanner = new LLMPlanner(
      plannerConfig || {
        serverUrl: "http://127.0.0.1:8001",
        onDeviceModel: "onnx-community/Qwen2.5-1.5B-Instruct",
      }
    );
    this.maxIterations = DEFAULT_MAX_ITERATIONS;
  }

  setPlannerConfig(config: PlannerConfig): void {
    this.llmPlanner.setConfig(config);
  }

  getActivities(): AgentActivity[] {
    return this.activities;
  }

  getActionHistory(): Array<{
    prompt: string;
    action: PlannedAction;
    result?: ActionResult;
  }> {
    return this.actionHistory;
  }

  /**
   * Build a compact privacy summary for the UI's redaction card.
   * The caller is expected to run the privacy firewall first via
   * `sanitizePage()` (which the session does at the start of each
   * prompt). If called before any prompt has run, returns an empty
   * summary.
   */
  getRedactionSummary(inProgress = false): RedactionSummary {
    const tokens = this.privacyFirewall.getLocalTokenMap();
    const byType: Record<string, number> = {};
    for (const t of tokens) {
      byType[t.type] = (byType[t.type] || 0) + 1;
    }
    return {
      count: tokens.length,
      byType,
      inProgress,
    };
  }

  /** Re-run the privacy firewall now and return the summary. Used when
   *  the user wants to refresh the redaction card without sending a
   *  prompt. */
  refreshRedactionSummary(): RedactionSummary {
    const rawDOM = extractPageDOM();
    this.privacyFirewall.sanitizePage(rawDOM);
    return this.getRedactionSummary(false);
  }

  cancel(): void {
    this.cancelled = true;
  }

  /**
   * Process one user prompt end-to-end with multi-iteration feedback.
   */
  async runPrompt(prompt: string): Promise<boolean> {
    this.cancelled = false;

    // Echo user message
    this.push({
      kind: "user",
      text: prompt,
    });

    let iteration = 0;
    let previousResult: ActionResult | undefined = undefined;

    while (iteration < this.maxIterations) {
      if (this.cancelled) {
        this.push({ kind: "info", text: "Cancelled" });
        return false;
      }

      iteration++;
      if (iteration > 1) {
        this.push({
          kind: "stage",
          text: `Iteration ${iteration}/${this.maxIterations}`,
          detail: "Re-reading page state",
        });
      } else {
        this.push({
          kind: "stage",
          text: "Understanding task",
          detail: `Parsing natural-language prompt`,
        });
      }

      // 1. Capture current page state (DOM only — fast path)
      if (iteration === 1) {
        this.push({ kind: "stage", text: "Analyzing page", detail: "Reading DOM structure" });
      }
      const rawDOM = extractPageDOM();
      const sanitizedDOM = this.privacyFirewall.sanitizePage(rawDOM);

      // 2. Privacy processing
      if (iteration === 1) {
        const tokens = this.privacyFirewall.getLocalTokenMap();
        this.push({
          kind: "stage",
          text: "Privacy Firewall",
          detail:
            tokens.length > 0
              ? `${tokens.length} sensitive value(s) protected locally`
              : "No sensitive values detected",
        });

        this.push({
          kind: "stage",
          text: "Sanitized context ready",
          detail: `${sanitizedDOM.elements.length} elements prepared for reasoning`,
        });
      }

      // 3. Plan action via LLM (with optional fallback)
      this.push({ kind: "llm_thinking", text: "Agent reasoning", detail: "Planning next browser action" });
      const planningCtx: PlanningContext = {
        sanitizedDOM,
        actionHistory: this.actionHistory.map((h) => h.action),
      };
      const llmHistory: ActionHistoryEntry[] = this.actionHistory.map((h) => ({
        prompt: h.prompt,
        action: {
          action: h.action.action,
          target: h.action.target,
          value: h.action.value,
          direction: h.action.direction,
          amount: h.action.amount,
          confidence: h.action.confidence,
          reasoning: h.action.reasoning,
        },
        result: h.result
          ? { success: h.result.success, message: h.result.message }
          : undefined,
      }));

      const planResult = await this.llmPlanner.plan(planningCtx, prompt, llmHistory);

      // Surface the planner's backend label to whatever UI wants it
      // (typically the header's provider pill).
      this.callbacks.onPlanResult?.(planResult);

      if (!planResult.action) {
        if (planResult.source === "none") {
          this.push({
            kind: "error",
            text: "Could not interpret the task",
            detail: "Try: 'scroll down', 'click submit', 'fill the email with X'",
          });
          return false;
        }
        // LLM produced a "done" action or null but not an error
        this.push({
          kind: "iteration_complete",
          text: "Task complete",
          detail: `Source: ${planResult.source}`,
        });
        return true;
      }

      const action = planResult.action;
      this.push({
        kind: "action_planned",
        text: formatPlannedAction(action),
        detail: `${action.reasoning || ""}  •  via ${planResult.source}`.trim(),
        meta: { action, source: planResult.source },
      });

      // 4. Validate
      this.push({
        kind: "stage",
        text: "Validating action",
        detail: "Schema + target + policy",
      });
      const validation = this.executor.validate(action);
      if (!validation.valid) {
        const reason = validation.reason || "Unknown reason";
        // Surface a helpful hint for the most common failure.
        const hint =
          /missing.*value|requires.*value/i.test(reason)
            ? " Try: 'fill name with [your value]'"
            : "";
        this.push({
          kind: "action_rejected",
          text: `Action rejected: ${reason}${hint}`,
          detail: `Confidence ${action.confidence.toFixed(2)}`,
        });
        this.actionHistory.push({ prompt, action, result: undefined });
        // Don't loop on validation failures — return so the user can rephrase
        return false;
      }
      this.push({ kind: "action_validated", text: "Action validated", detail: "OK" });

      // 5. Execute
      this.push({
        kind: "stage",
        text: "Executing action",
        detail: action.action,
      });
      const result = await this.executor.execute(action);
      previousResult = result;
      this.actionHistory.push({ prompt, action, result });

      if (result.success) {
        this.push({
          kind: "action_executed",
          text: result.message,
          detail: `Confidence ${action.confidence.toFixed(2)} • ${result.durationMs.toFixed(0)}ms`,
        });

        // 6. Verify by re-reading DOM
        await this.delay(150);
        const newDOM = extractPageDOM();
        const newSanitized = this.privacyFirewall.sanitizePage(newDOM);
        this.push({
          kind: "stage",
          text: "Verification",
          detail: `Page re-read: ${newSanitized.elements.length} elements`,
        });

        // 7. If the LLM already signaled done on this action, exit
        if (planResult.llmAction?.done) {
          this.push({
            kind: "iteration_complete",
            text: "Task complete (LLM signaled done)",
            detail: `Iterations used: ${iteration}`,
          });
          return true;
        }

        // If the LLM didn't say done but this was a terminal action
        // (e.g. click submit that triggers a navigation/state change),
        // still allow one more iteration so the LLM can confirm completion.
        if (iteration >= this.maxIterations) {
          this.push({
            kind: "info",
            text: "Reached iteration cap",
            detail: `Stopped after ${iteration} iteration(s)`,
          });
          return true;
        }

        // Continue loop — re-perceive, re-plan
        continue;
      } else {
        this.push({
          kind: "error",
          text: result.message,
          detail: "Action failed — try rephrasing the task",
        });
        return false;
      }
    }

    return true;
  }

  /**
   * Reset session state (history + activities).
   */
  reset(): void {
    this.activities = [];
    this.actionHistory = [];
    this.push({ kind: "info", text: "Session reset" });
  }

  private push(activity: Omit<AgentActivity, "id" | "timestamp">): AgentActivity {
    const full: AgentActivity = {
      ...activity,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: Date.now(),
    };
    this.activities.push(full);
    this.callbacks.onActivity?.(full);
    return full;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

function formatPlannedAction(action: PlannedAction): string {
  switch (action.action) {
    case "click":
      return `Click ${action.target}`;
    case "type":
      return `Type into ${action.target}${action.value ? ` (${displayValue(action.value)})` : ""}`;
    case "scroll":
      return `Scroll ${action.direction ?? "down"} ${action.amount ?? 500}px`;
    case "select":
      return `Select "${action.value}" in ${action.target}`;
    case "wait":
      return `Wait ${action.amount ?? 1000}ms`;
    case "navigate":
      return `Navigate to ${action.target ?? action.value ?? "?"}`;
    default:
      return `${action.action} ${action.target ?? ""}`;
  }
}

function displayValue(v: string): string {
  if (/^\[[A-Z_]+_\d+\]$/.test(v)) return v; // looks like a token
  if (v.length > 40) return v.slice(0, 37) + "…";
  return v;
}
