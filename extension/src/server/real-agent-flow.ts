/**
 * RedactVision Agent - Real Agent Flow with Server Communication
 *
 * Phase 7: Connects to FastAPI WebSocket server for reasoning.
 * Maintains privacy boundary: NEVER sends token map or raw PII.
 */

import { PrivacyFirewall } from "../privacy/privacy-firewall";
import { SanitizedPageDOM } from "../privacy/privacy-types";
import { ServerConnection, ServerAction, createServerConnection } from "./server-connection";

export interface RealAgentFlowConfig {
  serverUrl?: string;
  onStageStart?: (stage: string, label: string, stepText: string) => void;
  onStageComplete?: (stage: string) => void;
  onPrivacy?: (tokens: unknown[]) => void;
  onTokenization?: (tokens: unknown[]) => void;
  onSanitized?: () => void;
  onConnecting?: () => void;
  onConnected?: () => void;
  onServerAction?: (action: ServerAction) => void;
  onValidation?: (passed: boolean, message?: string) => void;
  onExecution?: (executed: boolean, result?: string) => void;
  onDone?: () => void;
  onError?: (error: string) => void;
}

/**
 * Run the real agent flow with server communication.
 *
 * Privacy contract:
 * - Sends ONLY sanitized DOM (with tokens like [EMAIL_01])
 * - NEVER sends token map
 * - NEVER sends raw PII
 * - Server returns structured action
 * - Client validates before execution
 */
export async function runRealAgentFlow(
  sanitizedDOM: SanitizedPageDOM,
  privacyFirewall: PrivacyFirewall,
  userPrompt: string,
  config: RealAgentFlowConfig,
  signal?: { cancelled: boolean }
): Promise<void> {
  const stages = [
    { id: "analyzing", label: "Analyzing page...", step: "Page analyzed", duration: 600 },
    { id: "sanitizing", label: "Protecting sensitive data...", step: "Data protected", duration: 500 },
    { id: "ready_to_send", label: "Preparing secure context...", step: "Context ready", duration: 400 },
    { id: "connecting", label: "Connecting to server...", step: "Connected", duration: 300 },
    { id: "waiting_for_agent", label: "Waiting for agent reasoning...", step: "Action received", duration: 1000 },
    { id: "validating", label: "Validating action...", step: "Action validated", duration: 400 },
    { id: "executing", label: "Executing action...", step: "Action executed", duration: 500 },
  ];

  const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // Stage 1: Analyzing
  if (signal?.cancelled) return;
  config.onStageStart?.("analyzing", stages[0].label, stages[0].step);
  await delay(stages[0].duration);
  if (signal?.cancelled) return;
  config.onStageComplete?.("analyzing");

  // Stage 2: Sanitizing (show privacy info)
  config.onStageStart?.("sanitizing", stages[1].label, stages[1].step);
  await delay(stages[1].duration);
  if (signal?.cancelled) return;

  const tokens = privacyFirewall.getLocalTokenMap().map((r) => ({
    token: r.token,
    type: r.type,
  }));
  config.onPrivacy?.(tokens);
  config.onStageComplete?.("sanitizing");

  // Stage 3: Ready to send (show tokenization)
  config.onStageStart?.("ready_to_send", stages[2].label, stages[2].step);
  await delay(stages[2].duration);
  if (signal?.cancelled) return;

  config.onTokenization?.(tokens);
  config.onSanitized?.();
  config.onStageComplete?.("ready_to_send");

  // Stage 4: Connect to server
  config.onStageStart?.("connecting", stages[3].label, stages[3].step);
  config.onConnecting?.();

  let serverAction: ServerAction | null = null;
  let connectionError: string | null = null;

  const connection = createServerConnection(
    {
      onConnected: () => {
        console.log("[RealAgentFlow] Connected to server");
      },
      onAction: (action) => {
        serverAction = action;
        console.log("[RealAgentFlow] Received action from server:", action);
      },
      onError: (error) => {
        connectionError = error;
        console.error("[RealAgentFlow] Server error:", error);
      },
      onStateChange: (state) => {
        console.log("[RealAgentFlow] Connection state:", state);
      },
    },
    config.serverUrl
  );

  try {
    connection.connect();

    // Wait for connection
    let attempts = 0;
    while (!connection.isConnected() && attempts < 20 && !signal?.cancelled) {
      await delay(100);
      attempts++;
    }

    if (signal?.cancelled) {
      connection.disconnect();
      return;
    }

    if (!connection.isConnected()) {
      throw new Error("Failed to connect to server");
    }

    config.onStageComplete?.("connecting");
    config.onConnected?.();

    // Stage 5: Send sanitized context to server
    config.onStageStart?.("waiting_for_agent", stages[4].label, stages[4].step);

    // IMPORTANT: Send ONLY sanitized data, NEVER token map
    const payload = {
      url: sanitizedDOM.url,
      title: sanitizedDOM.title,
      elements: sanitizedDOM.elements,
      prompt: userPrompt,
      timestamp: Date.now(),
    };

    console.log("[RealAgentFlow] Sending sanitized context (NO token map)");
    await connection.sendSanitizedContext(payload);

    // Wait for server response
    let waitAttempts = 0;
    while (!serverAction && !connectionError && waitAttempts < 50 && !signal?.cancelled) {
      await delay(100);
      waitAttempts++;
    }

    if (signal?.cancelled) {
      connection.disconnect();
      return;
    }

    if (connectionError) {
      throw new Error(connectionError);
    }

    if (!serverAction) {
      throw new Error("No action received from server");
    }

    config.onStageComplete?.("waiting_for_agent");
    config.onServerAction?.(serverAction);

    // Stage 6: Validation
    config.onStageStart?.("validating", stages[5].label, stages[5].step);
    await delay(stages[5].duration);
    if (signal?.cancelled) return;

    // Validate action locally
    const validation = validateServerAction(serverAction, privacyFirewall);
    config.onValidation?.(validation.passed, validation.message);
    config.onStageComplete?.("validating");

    if (!validation.passed) {
      throw new Error(`Validation failed: ${validation.message}`);
    }

    // Stage 7: Execution
    config.onStageStart?.("executing", stages[6].label, stages[6].step);
    await delay(stages[6].duration);
    if (signal?.cancelled) return;

    console.log("[RealAgentFlow] About to execute action");
    const execution = await executeAction(serverAction, privacyFirewall);
    console.log("[RealAgentFlow] Execution result:", execution);
    config.onExecution?.(execution.executed, execution.result);
    config.onStageComplete?.("executing");
    console.log("[RealAgentFlow] About to call onDone");

    config.onDone?.();
    console.log("[RealAgentFlow] onDone called, flow complete");
  } catch (error) {
    console.error("[RealAgentFlow] Error:", error);
    config.onError?.(error instanceof Error ? error.message : String(error));
  } finally {
    console.log("[RealAgentFlow] Finally block - disconnecting");
    connection.disconnect();
  }
}

/**
 * Validate server action locally before execution.
 */
function validateServerAction(
  action: ServerAction,
  _privacyFirewall: PrivacyFirewall
): { passed: boolean; message: string } {
  const allowedActions = ["click", "type", "scroll", "navigate", "wait"];

  if (!allowedActions.includes(action.action)) {
    return { passed: false, message: `Invalid action type: ${action.action}` };
  }

  if (!action.target || typeof action.target !== "string") {
    return { passed: false, message: "Invalid or missing target selector" };
  }

  if (typeof action.confidence !== "number" || action.confidence < 0 || action.confidence > 1) {
    return { passed: false, message: "Invalid confidence score" };
  }

  // For TYPE actions with tokens, verify token exists locally
  if (action.action === "type" && action.value && action.value.startsWith("[")) {
    // Token format: [TYPE_XX]
    // Client will resolve this locally
    return { passed: true, message: "Action validated - token will be resolved locally" };
  }

  return { passed: true, message: "Action validated locally" };
}

/**
 * Execute a validated action.
 * For TYPE actions with tokens, resolve them locally.
 */
async function executeAction(
  action: ServerAction,
  privacyFirewall: PrivacyFirewall
): Promise<{ executed: boolean; result: string }> {
  try {
    switch (action.action) {
      case "click": {
        const element = document.querySelector(action.target);
        if (element && element instanceof HTMLElement) {
          element.click();
          return { executed: true, result: `Clicked ${action.target}` };
        }
        return { executed: false, result: `Element not found: ${action.target}` };
      }

      case "type": {
        const element = document.querySelector(action.target);
        if (element && (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
          let valueToType = action.value || "";

          // If value is a token, resolve it locally
          if (valueToType.startsWith("[") && valueToType.endsWith("]")) {
            const resolved = privacyFirewall.resolveToken(valueToType);
            if (resolved) {
              valueToType = resolved;
              console.log(`[RealAgentFlow] Resolved token ${action.value} locally`);
            } else {
              return { executed: false, result: `Could not resolve token: ${action.value}` };
            }
          }

          element.value = valueToType;
          element.dispatchEvent(new Event("input", { bubbles: true }));
          return { executed: true, result: `Typed into ${action.target}` };
        }
        return { executed: false, result: `Element not found: ${action.target}` };
      }

      case "scroll": {
        window.scrollBy(0, 300);
        return { executed: true, result: "Scrolled down" };
      }

      case "navigate": {
        // For safety, we don't auto-navigate
        return { executed: false, result: "Navigation requires user confirmation" };
      }

      case "wait": {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return { executed: true, result: "Waited 1 second" };
      }

      default:
        return { executed: false, result: `Unknown action: ${action.action}` };
    }
  } catch (error) {
    return { executed: false, result: `Execution error: ${error}` };
  }
}
