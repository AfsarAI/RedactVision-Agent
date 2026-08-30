/**
 * RedactVision Agent - Session / Agent Loop (LLM-backed)
 *
 * A session maintains:
 *  - conversation history (user prompts + agent activities)
 *  - action history (planned + executed actions with results)
 *  - per-task state machine
 *
 * The agent loop implements the correct task lifecycle:
 *
 *   prompt → perceive → plan → validate → execute → observe
 *                ↑                                          │
 *                └──── replan if NOT done ◄─────────────────┘
 *                          (or safety cap)
 *
 * The loop is governed by **completion detection**, not by counting
 * iterations. It exits cleanly when ANY of the following is true:
 *
 *   1. The planner returns a "done" action or null with source≠"none".
 *   2. The same action has already been executed successfully this
 *      prompt (duplicate-action guard — see `isDuplicateAction`).
 *   3. The action was terminal and the page state has stabilised
 *      (e.g. navigation completed, form already filled).
 *
 * `maxIterations` remains a SAFETY cap to prevent genuine infinite
 * loops, not the normal mechanism for finishing a task.
 */

import type { PlannedAction, ActionResult } from "../executor/action-executor";
import { ActionExecutor } from "../executor/action-executor";
import { PlanningContext } from "./action-planner";
import { LLMPlanner, PlannerConfig, PlannerResult } from "../llm/llm-planner";
import { ActionHistoryEntry } from "../llm/action-schema";
import { extractPageDOM } from "../content/dom-extractor";
import { PrivacyFirewall } from "../privacy/privacy-firewall";
import type { SanitizedPageDOM } from "../privacy/privacy-types";

const DEFAULT_MAX_ITERATIONS = 8;

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

/** Internal task lifecycle states. */
export type TaskPhase =
  | "idle"
  | "perceiving"
  | "planning"
  | "validating"
  | "executing"
  | "observing"
  | "completed"
  | "failed"
  | "cancelled"
  | "max_iterations_reached"
  | "offline";

export interface TaskOutcome {
  phase: TaskPhase;
  iterations: number;
  actionsPlanned: number;
  actionsExecuted: number;
  durationMs: number;
  reason: string;
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

  setMaxIterations(n: number): void {
    this.maxIterations = Math.max(1, Math.floor(n));
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
   * Process one user prompt end-to-end with proper completion
   * detection. Returns a structured TaskOutcome describing how the
   * loop terminated.
   */
  async runPrompt(prompt: string): Promise<TaskOutcome> {
    const startedAt = performance.now();
    this.cancelled = false;

    // Echo user message
    this.push({ kind: "user", text: prompt });

    // Per-prompt state.
    let iteration = 0;
    let actionsPlanned = 0;
    let actionsExecuted = 0;
    let phase: TaskPhase = "perceiving";
    let reason = "Task completed successfully";

    while (iteration < this.maxIterations) {
      if (this.cancelled) {
        phase = "cancelled";
        reason = "Cancelled by user";
        this.push({ kind: "info", text: "Cancelled" });
        break;
      }

      iteration++;
      phase = "perceiving";

      if (iteration === 1) {
        this.push({
          kind: "stage",
          text: "Understanding task",
          detail: "Parsing natural-language prompt",
        });
      } else {
        this.push({
          kind: "stage",
          text: `Re-evaluating page`,
          detail: `Iteration ${iteration}/${this.maxIterations}`,
        });
      }

      // 1. Capture current page state (DOM only — fast path)
      if (iteration === 1) {
        this.push({ kind: "stage", text: "Analyzing page", detail: "Reading DOM structure" });
      }
      const rawDOM = extractPageDOM();
      const sanitizedDOM = this.privacyFirewall.sanitizePage(rawDOM);

      // 2. Privacy processing (only narrate on the first iteration)
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

      // 3. Plan action via LLM (with fallback)
      phase = "planning";
      this.push({
        kind: "llm_thinking",
        text: "Agent reasoning",
        detail: "Planning next browser action",
      });
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
      this.callbacks.onPlanResult?.(planResult);

      // No action → either "done" (success) or planner failure.
      if (!planResult.action) {
        if (planResult.source === "none") {
          // Distinguish "agent offline" from "task uninterpretable".
          const isOffline =
            planResult.errorCode === "llm_not_configured" ||
            planResult.errorCode === "llm_unavailable" ||
            planResult.errorCode === "server_unreachable";
          phase = isOffline ? "offline" : "failed";
          reason = isOffline
            ? `Server agent offline: ${planResult.errorCode || "unavailable"}`
            : planResult.errorCode
            ? `Planner rejected task: ${planResult.errorCode}`
            : "Planner did not return an action";
          this.push({
            kind: "error",
            text: isOffline
              ? "Server agent is offline"
              : "Could not plan a next action",
            detail:
              planResult.message ||
              (isOffline
                ? "Check that the server is running and has at least one LLM provider configured."
                : "Try rephrasing the task."),
          });
        } else {
          phase = "completed";
          reason = "Planner signaled completion";
          this.push({
            kind: "iteration_complete",
            text: "Task complete",
            detail: `Source: ${planResult.source}`,
          });
        }
        break;
      }

      const action = planResult.action;
      actionsPlanned++;

      // ── Duplicate-action guard (loop safety net) ───────────────────
      // The server's LLM is the sole planner and is expected to signal
      // `done: true` when the task is complete. This guard exists only
      // to catch a genuine infinite loop (e.g. a stuck LLM) — it does
      // NOT replace the planner's completion signal. We compare the
      // action's full executable signature (type + target + value +
      // direction + amount).
      if (this.wasActionExecutedSuccessfully(action)) {
        phase = "completed";
        reason = "Task satisfied — no further action required";
        this.push({
          kind: "info",
          text: "Action already executed",
          detail: "The requested action has already been performed.",
        });
        this.push({
          kind: "iteration_complete",
          text: "Task complete",
          detail: "The planner produced an action that was already executed",
        });
        break;
      }

      this.push({
        kind: "action_planned",
        text: formatPlannedAction(action),
        detail: buildPlannedDetail(action, planResult),
        meta: { action, source: planResult.source },
      });

      // 4. Validate
      phase = "validating";
      this.push({
        kind: "stage",
        text: "Validating action",
        detail: "Schema + target + policy",
      });
      const validation = this.executor.validate(action);
      if (!validation.valid) {
        const reasonText = validation.reason || "Unknown reason";
        const hint =
          /missing.*value|requires.*value/i.test(reasonText)
            ? " Try: 'fill name with [your value]'"
            : "";
        this.push({
          kind: "action_rejected",
          text: `Action rejected: ${reasonText}${hint}`,
          detail: `Confidence ${action.confidence.toFixed(2)}`,
        });
        this.actionHistory.push({ prompt, action, result: undefined });
        phase = "failed";
        reason = `Action validation failed: ${reasonText}`;
        break;
      }
      this.push({ kind: "action_validated", text: "Action validated", detail: "OK" });

      // 5. Execute
      phase = "executing";
      this.push({
        kind: "stage",
        text: "Executing action",
        detail: action.action,
      });
      const result = await this.executor.execute(action);
      this.actionHistory.push({ prompt, action, result });

      if (!result.success) {
        actionsExecuted++;
        phase = "failed";
        reason = `Action execution failed: ${result.message}`;
        this.push({
          kind: "error",
          text: result.message,
          detail: "Action failed — try rephrasing the task",
        });
        break;
      }

      actionsExecuted++;

      this.push({
        kind: "action_executed",
        text: result.message,
        detail: `Confidence ${action.confidence.toFixed(2)} • ${result.durationMs.toFixed(0)}ms`,
      });

      // 6. Observe
      phase = "observing";
      await this.delay(150);
      const newDOM = extractPageDOM();
      const newSanitized = this.privacyFirewall.sanitizePage(newDOM);
      this.push({
        kind: "stage",
        text: "Observation",
        detail: `Page re-read: ${newSanitized.elements.length} elements`,
      });

      // 7. If the planner explicitly signalled "done" with this
      //    action, treat the task as complete.
      if (planResult.llmAction?.done) {
        phase = "completed";
        reason = "Planner signaled task complete";
        this.push({
          kind: "iteration_complete",
          text: "Task complete",
          detail: `Iterations used: ${iteration}`,
        });
        break;
      }

      // 8. Safety cap.
      if (iteration >= this.maxIterations) {
        phase = "max_iterations_reached";
        reason = "Safety iteration cap reached without a completion signal";
        this.push({
          kind: "info",
          text: "Reached safety cap",
          detail: `Stopped after ${iteration} iteration(s) to prevent an infinite loop`,
        });
        this.push({
          kind: "error",
          text: "Agent could not determine successful completion",
          detail: "The agent stopped because it could not decide that the task was done.",
        });
        break;
      }

      // Otherwise loop — re-perceive, re-plan.
      continue;
    }

    // If we exited the loop without setting a terminal phase, we
    // exhausted the safety cap.
    if (
      phase !== "completed" &&
      phase !== "failed" &&
      phase !== "cancelled" &&
      phase !== "max_iterations_reached" &&
      phase !== "offline"
    ) {
      phase = "max_iterations_reached";
      reason = "Safety iteration cap reached";
    }

    return {
      phase,
      iterations: iteration,
      actionsPlanned,
      actionsExecuted,
      durationMs: performance.now() - startedAt,
      reason,
    };
  }

  /**
   * Reset session state (history + activities).
   */
  reset(): void {
    this.activities = [];
    this.actionHistory = [];
    this.push({ kind: "info", text: "Session reset" });
  }

  /**
   * Returns true if the given action was already executed
   * successfully for the SAME prompt. Used to detect stuck loops
   * where the planner keeps re-emitting the same action.
   */
  private wasActionExecutedSuccessfully(action: PlannedAction): boolean {
    for (const h of this.actionHistory) {
      if (h.result?.success !== true) continue;
      if (isSameAction(h.action, action)) return true;
    }
    return false;
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

/**
 * Two actions are considered "the same" if their executable core
 * matches. We compare type + target + value + direction + amount —
 * NOT just the string. This lets us detect duplicate scroll/click/
 * type attempts even if the LLM slightly reformats the reasoning
 * text.
 */
function isSameAction(a: PlannedAction, b: PlannedAction): boolean {
  if (a.action !== b.action) return false;
  if (norm(a.target) !== norm(b.target)) return false;
  if (norm(a.value) !== norm(b.value)) return false;
  if (norm(a.direction) !== norm(b.direction)) return false;
  const am = a.amount ?? null;
  const bm = b.amount ?? null;
  if (am !== bm) return false;
  return true;
}

function norm<T>(v: T | undefined | null): T | null {
  if (v === undefined) return null;
  if (v === null) return null;
  return v;
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

function buildPlannedDetail(action: PlannedAction, planResult: PlannerResult): string {
  // NEVER include the raw server "source" in the detail string. The
  // UI already shows the backend pill in the header. We only surface
  // a generic "reasoning" hint if it's safe to log.
  const reasoning = (action.reasoning || "").trim();
  if (!reasoning) return "Action planned";
  // Truncate the reasoning to keep the timeline tidy.
  const trimmed = reasoning.length > 80 ? reasoning.slice(0, 77) + "…" : reasoning;
  return trimmed;
}

// Re-export for convenience.
export type { PlannerResult } from "../llm/llm-planner";
