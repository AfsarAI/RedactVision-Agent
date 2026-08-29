/**
 * RedactVision Agent - Local Task State Machine
 *
 * Phase 6: Manages the local agent task orchestration state.
 * Ensures consistent state between popup and in-page panel.
 *
 * States:
 * IDLE → ANALYZING → SANITIZING → READY_TO_SEND → WAITING_FOR_AGENT →
 * ACTION_RECEIVED → VALIDATING → EXECUTING → COMPLETED | ERROR
 */

export type AgentState =
  | "idle"
  | "analyzing"
  | "sanitizing"
  | "ready_to_send"
  | "waiting_for_agent"
  | "action_received"
  | "validating"
  | "executing"
  | "completed"
  | "error";

/**
 * Valid state transitions
 */
const STATE_TRANSITIONS: Record<AgentState, AgentState[]> = {
  idle: ["analyzing"],
  analyzing: ["sanitizing", "error"],
  sanitizing: ["ready_to_send", "error"],
  ready_to_send: ["waiting_for_agent", "error"],
  waiting_for_agent: ["action_received", "error"],
  action_received: ["validating", "error"],
  validating: ["executing", "error"],
  executing: ["completed", "error"],
  completed: ["idle"],
  error: ["idle"],
};

/**
 * State labels for UI display
 */
export const STATE_LABELS: Record<AgentState, string> = {
  idle: "Ready",
  analyzing: "Analyzing page...",
  sanitizing: "Protecting sensitive data...",
  ready_to_send: "Preparing secure context...",
  waiting_for_agent: "Waiting for agent...",
  action_received: "Action received",
  validating: "Validating action...",
  executing: "Executing action...",
  completed: "Completed",
  error: "Error",
};

/**
 * CSS class for each state (for status dot styling)
 */
export const STATE_CSS_CLASS: Record<AgentState, string> = {
  idle: "",
  analyzing: "rv-analyzing",
  sanitizing: "rv-protecting",
  ready_to_send: "rv-preparing",
  waiting_for_agent: "rv-thinking",
  action_received: "rv-thinking",
  validating: "rv-analyzing",
  executing: "rv-analyzing",
  completed: "rv-completed",
  error: "rv-error",
};

/**
 * State machine configuration
 */
export interface StateMachineConfig {
  onStateChange?: (from: AgentState, to: AgentState) => void;
  onError?: (state: AgentState, error: Error) => void;
}

/**
 * Create a new agent state machine instance
 */
export function createStateMachine(config?: StateMachineConfig): AgentStateMachine {
  return new AgentStateMachineImpl(config);
}

/**
 * State machine interface
 */
export interface AgentStateMachine {
  /** Get current state */
  getState(): AgentState;
  /** Get state label for UI */
  getLabel(): string;
  /** Get CSS class for current state */
  getCSSClass(): string;
  /** Transition to a new state */
  transition(to: AgentState): boolean;
  /** Check if can transition to a state */
  canTransitionTo(to: AgentState): boolean;
  /** Reset to idle */
  reset(): void;
  /** Set error state */
  setError(message?: string): void;
  /** Subscribe to state changes */
  subscribe(callback: (from: AgentState, to: AgentState) => void): () => void;
  /** Get error message if in error state */
  getErrorMessage(): string | null;
}

/**
 * Internal state machine implementation
 */
class AgentStateMachineImpl implements AgentStateMachine {
  private state: AgentState = "idle";
  private errorMessage: string | null = null;
  private subscribers: Set<(from: AgentState, to: AgentState) => void> = new Set();
  private config?: StateMachineConfig;

  constructor(config?: StateMachineConfig) {
    this.config = config;
  }

  getState(): AgentState {
    return this.state;
  }

  getLabel(): string {
    return STATE_LABELS[this.state];
  }

  getCSSClass(): string {
    return STATE_CSS_CLASS[this.state];
  }

  canTransitionTo(to: AgentState): boolean {
    const allowed = STATE_TRANSITIONS[this.state];
    return allowed.includes(to);
  }

  transition(to: AgentState): boolean {
    if (!this.canTransitionTo(to)) {
      console.warn(
        `[StateMachine] Invalid transition: ${this.state} → ${to}. Valid: ${STATE_TRANSITIONS[this.state].join(", ")}`
      );
      return false;
    }

    const from = this.state;
    this.state = to;
    this.errorMessage = null;

    // Notify subscribers
    this.subscribers.forEach((cb) => cb(from, to));

    // Call config callback
    this.config?.onStateChange?.(from, to);

    console.log(`[StateMachine] ${from} → ${to}`);
    return true;
  }

  reset(): void {
    const from = this.state;
    this.state = "idle";
    this.errorMessage = null;
    this.subscribers.forEach((cb) => cb(from, "idle"));
    this.config?.onStateChange?.(from, "idle");
  }

  setError(message: string = "An error occurred"): void {
    this.errorMessage = message;
    const from = this.state;
    this.state = "error";
    this.subscribers.forEach((cb) => cb(from, "error"));
    this.config?.onStateChange?.(from, "error");
    this.config?.onError?.(this.state, new Error(message));
  }

  subscribe(callback: (from: AgentState, to: AgentState) => void): () => void {
    this.subscribers.add(callback);
    return () => this.subscribers.delete(callback);
  }

  getErrorMessage(): string | null {
    return this.errorMessage;
  }
}

/**
 * Pipeline step definitions for the agent flow
 */
export interface PipelineStep {
  state: AgentState;
  label: string;
  stepText: string;
  duration: number;
}

/**
 * Standard pipeline for agent task execution
 */
export const AGENT_PIPELINE: PipelineStep[] = [
  { state: "analyzing", label: "Analyzing page...", stepText: "Page analyzed", duration: 900 },
  { state: "sanitizing", label: "Protecting sensitive data...", stepText: "Sensitive data protected", duration: 1100 },
  { state: "ready_to_send", label: "Preparing secure context...", stepText: "Sanitized context ready", duration: 800 },
  { state: "waiting_for_agent", label: "Waiting for agent...", stepText: "Agent reasoning (mock)", duration: 1400 },
  { state: "action_received", label: "Action received", stepText: "Action ready", duration: 600 },
];

/**
 * Extended pipeline including validation and execution
 */
export const FULL_PIPELINE: PipelineStep[] = [
  ...AGENT_PIPELINE,
  { state: "validating", label: "Validating action...", stepText: "Action validated", duration: 500 },
  { state: "executing", label: "Executing action...", stepText: "Action executed", duration: 700 },
];

/**
 * Utility to create a delayed promise
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}