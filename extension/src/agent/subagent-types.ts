/**
 * RedactVision Agent — Fan-Out Subagent Types
 *
 * Defines the contract for multi-tab parallel subagent execution,
 * task decomposition, inter-tab messaging, and result synthesis.
 */

export type SubagentStatus =
  | "pending"
  | "spawning"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface SubagentTask {
  id: string;
  label: string;
  url: string;
  prompt: string;
  status: SubagentStatus;
  tabId?: number;
  actionsCount?: number;
  resultMessage?: string;
  error?: string;
  startTime?: number;
  durationMs?: number;
}

export interface FanOutPlan {
  isFanOut: boolean;
  objective: string;
  subagents: SubagentTask[];
  maxConcurrency?: number;
}

export interface SubagentProgressEvent {
  subagentId: string;
  status: SubagentStatus;
  actionText?: string;
  detail?: string;
}

export interface SubagentResultSummary {
  subagentId: string;
  label: string;
  url: string;
  success: boolean;
  summary: string;
  actionsExecuted: number;
  durationMs: number;
}

export interface FanOutOutcome {
  objective: string;
  totalSubagents: number;
  completedCount: number;
  failedCount: number;
  results: SubagentResultSummary[];
  durationMs: number;
  synthesizedReport: string;
}
