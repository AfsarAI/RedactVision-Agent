/**
 * RedactVision Agent - PlanningContext type
 *
 * The CLIENT has no natural-language planner. Action planning is
 * performed by the server-side LLM. This module exists only to keep
 * the shared `PlanningContext` type used by the agent session and
 * the server bridge.
 *
 * Any code that used to live here (keyword matching, regex-based
 * value extraction, etc.) was removed. Per the architecture
 * (CLAUDE.md §5, §18) the client MUST NOT interpret user prompts
 * locally.
 */

import type { PlannedAction } from "../executor/action-executor";
import type { SanitizedPageDOM } from "../privacy/privacy-types";

export interface PlanningContext {
  sanitizedDOM: SanitizedPageDOM;
  /** History of actions already performed in this task. */
  actionHistory?: PlannedAction[];
  /** The most recent successful action's result, if any. */
  lastResult?: { success: boolean; message: string } | undefined;
}
