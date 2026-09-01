/**
 * RedactVision Agent - Shared LLM action schema
 *
 * Defines the JSON contract that the LLM (client or server) must return.
 * Used by:
 *   - extension/src/llm/llm-planner.ts        (orchestrator)
 *   - extension/src/llm/client-llm.ts         (Transformers.js prompt)
 *   - server/redactvision_server/planner_prompt.py (server prompt — must mirror)
 *
 * PRIVACY: This schema is the only thing that crosses the network boundary.
 * The `value` field may contain a page token like [EMAIL_01] or a local
 * profile token like [PROFILE:email] — never the original value.
 */

export type LLMActionType =
  | "click"
  | "type"
  | "scroll"
  | "select"
  | "wait"
  | "navigate"
  | "open_tab"
  | "fanout"
  | "done";

/**
 * The structured action the LLM must produce.
 *
 * `done: true` signals the loop should exit (task complete).
 */
export interface LLMPlannedAction {
  action: LLMActionType;
  /** CSS selector for click/type/select. Omit for scroll/wait/done. */
  target?: string;
  /**
   * Value to type. May be a literal user-supplied non-sensitive string, a page
   * token like "[EMAIL_01]", or an encrypted local profile token like
   * "[PROFILE:pan_card]". The executor resolves tokens locally.
   */
  value?: string;
  /** For scroll. Defaults to "down" if action === "scroll" and direction omitted. */
  direction?: "up" | "down" | "left" | "right";
  /** Pixel amount for scroll, or milliseconds for wait. */
  amount?: number;
  /** Confidence score in [0, 1]. */
  confidence: number;
  /** Short human-readable reasoning for the UI. */
  reasoning?: string;
  /** Set true when the task is complete and the loop should exit. */
  done?: boolean;
}

/**
 * History entry fed back to the LLM on each iteration.
 */
export interface ActionHistoryEntry {
  prompt: string;
  action: LLMPlannedAction;
  result?: {
    success: boolean;
    message: string;
  };
}

/**
 * The input the LLM receives.
 */
export interface LLMPlannerInput {
  userPrompt: string;
  sanitizedDOM: {
    url: string;
    title: string;
    elements: Array<{
      tag: string;
      id: string | null;
      name: string | null;
      type: string | null;
      text: string;
      value: string | null;
      placeholder: string | null;
      ariaLabel: string | null;
      /** Label text from the associated <label> element — primary signal
       *  for the local LLM to determine field semantics dynamically. */
      label: string;
      selector: string;
    }>;
  };
  history?: ActionHistoryEntry[];
}

/**
 * Validate that an LLMPlannedAction has the required fields and reasonable values.
 * Returns { ok: true, action } on success; { ok: false, reason } on failure.
 */
export function validateLLMAction(raw: unknown): { ok: true; action: LLMPlannedAction } | { ok: false; reason: string } {
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, reason: "LLM output is not an object" };
  }
  const a = raw as Record<string, unknown>;

  // action
  const action = a.action as string;
  const allowed: LLMActionType[] = ["click", "type", "scroll", "select", "wait", "navigate", "open_tab", "fanout", "done"];
  if (!allowed.includes(action as LLMActionType)) {
    return { ok: false, reason: `Invalid action: ${action}` };
  }

  // confidence
  const conf = a.confidence as number;
  if (typeof conf !== "number" || conf < 0 || conf > 1) {
    return { ok: false, reason: "confidence must be a number in [0, 1]" };
  }

  // target required for click/type/select
  if ((action === "click" || action === "type" || action === "select") && typeof a.target !== "string") {
    return { ok: false, reason: `${action} requires a target string` };
  }

  // value required for type (unless done)
  if (action === "type" && typeof a.value !== "string") {
    return { ok: false, reason: "type action requires a value string" };
  }

  const out: LLMPlannedAction = {
    action: action as LLMActionType,
    confidence: conf,
  };
  if (typeof a.target === "string") out.target = a.target;
  if (typeof a.value === "string") out.value = a.value;
  if (typeof a.direction === "string") {
    const dir = a.direction as "up" | "down" | "left" | "right";
    if (["up", "down", "left", "right"].includes(dir)) out.direction = dir;
  }
  if (typeof a.amount === "number") out.amount = a.amount;
  if (typeof a.reasoning === "string") out.reasoning = a.reasoning;
  if (typeof a.done === "boolean") out.done = a.done;

  // If action === "done", default done to true
  if (action === "done") out.done = true;

  return { ok: true, action: out };
}

/**
 * Convert an LLMPlannedAction to the executor's PlannedAction shape.
 */
import type { PlannedAction } from "../executor/action-executor";

export function toExecutorAction(llm: LLMPlannedAction): PlannedAction | null {
  if (llm.action === "done") return null; // signals loop exit
  const out: PlannedAction = {
    action: llm.action as PlannedAction["action"],
    confidence: llm.confidence,
  };
  if (llm.target) out.target = llm.target;
  if (llm.value !== undefined) out.value = llm.value;
  if (llm.direction) out.direction = llm.direction;
  if (llm.amount !== undefined) out.amount = llm.amount;
  if (llm.reasoning) out.reasoning = llm.reasoning;
  return out;
}
