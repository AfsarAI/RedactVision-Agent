/**
 * RedactVision Agent — Planner Orchestrator (single flow with explicit override)
 *
 * Per architecture (docs/ARCHITECTURE.md, CLAUDE.md §5):
 *   - The server LLM is the SOLE planner.
 *   - The on-device model is a perception/sanitization helper inside the
 *     Privacy Firewall (extension/src/privacy). It is NEVER a planner.
 *   - The local deterministic planner (action-planner.ts) is the
 *     automatic, implicit fallback when the server is unreachable.
 *
 * Routing is controlled by `PlannerConfig.backend`:
 *   - "auto"       (default) — try server (5 s timeout) → fall back to local rules.
 *   - "server"     — try server only. Surface error if it fails. No fallback.
 *   - "local"      — use local rules only. Skip the server entirely.
 *   - "on-device"  — not implemented as a planner yet. Falls back to "auto"
 *                    with a console.warn so the user sees a soft notice.
 *
 * The user configures:
 *   - serverUrl      (where to POST)
 *   - onDeviceModel  (model id for the privacy firewall's visual PII
 *                     detector; not used by this orchestrator)
 *   - backend        (routing override, default "auto")
 *
 * NOTE: The extension never holds the server's API key. The server
 * reads provider keys (Gemini, Groq, etc.) from its own .env and uses
 * them on the user's behalf. This module therefore has no
 * `serverApiKey` field.
 */

import { planAction, PlanningContext } from "../agent/action-planner";
import type { PlannedAction } from "../executor/action-executor";
import {
  LLMPlannedAction,
  LLMPlannerInput,
  ActionHistoryEntry,
  toExecutorAction,
} from "./action-schema";
import { planViaServer, isInExtensionContext } from "./extension-bridge";

/** Routing override chosen in the popup's segmented control. */
export type PlannerBackend = "auto" | "server" | "on-device" | "local";

export interface PlannerConfig {
  /** Server LLM base URL. Default: http://127.0.0.1:8001 */
  serverUrl?: string;
  /**
   * On-device model id (Transformers.js). Used by the privacy firewall
   * to detect faces / canvas-rendered PII. Not used for action planning.
   */
  onDeviceModel?: string;
  /**
   * Routing override. Default "auto" (server → fallback to local).
   * See module header for the full matrix.
   */
  backend?: PlannerBackend;
}

export type PlannerSource = "server-llm" | "fallback-rules" | "none";

export interface PlannerResult {
  action: PlannedAction | null;
  /** Which source produced the result. */
  source: PlannerSource;
  /** Raw LLM response if from server. */
  llmAction?: LLMPlannedAction;
  /** Display label of the LLM provider that answered (e.g. "Groq", "Gemini"). */
  backendLabel?: string;
  /** Diagnostic message for the UI. */
  message?: string;
}

/** Hard ceiling for any single server call. Matches the service worker. */
const SERVER_TIMEOUT_MS = 5_000;

export class LLMPlanner {
  private config: PlannerConfig;

  constructor(config: PlannerConfig) {
    this.config = config;
  }

  setConfig(config: PlannerConfig): void {
    this.config = config;
  }

  getConfig(): PlannerConfig {
    return this.config;
  }

  /**
   * Plan the next action.
   *
   * Default ("auto"):
   *   1. Try the server LLM (5 s timeout).
   *   2. On any failure → fall back to the local deterministic planner.
   *   3. If local planner also returns null → source = "none".
   *
   * Explicit overrides:
   *   - "server"    — step 1 only; failure short-circuits to "none".
   *   - "local"     — step 2 only; the server is never contacted.
   *   - "on-device" — currently equivalent to "auto" (placeholder).
   */
  async plan(
    ctx: PlanningContext,
    userPrompt: string,
    history?: ActionHistoryEntry[]
  ): Promise<PlannerResult> {
    const input: LLMPlannerInput = {
      userPrompt,
      sanitizedDOM: ctx.sanitizedDOM,
      history,
    };
    const backend: PlannerBackend = this.config.backend || "auto";

    // ON-DEVICE is a stub — log a soft notice and fall through to AUTO.
    if (backend === "on-device") {
      console.warn(
        "[LLMPlanner] backend='on-device' is not yet implemented as a planner. " +
          "Falling back to auto (server → local rules)."
      );
    }
    const effective: "auto" | "server" | "local" =
      backend === "on-device" ? "auto" : backend;

    // 1. Try server LLM via the extension bridge (unless "local")
    if (effective !== "local") {
      const serverResult = await this.tryServer(input);
      if (serverResult.action) {
        return {
          action: toExecutorAction(serverResult.action),
          source: "server-llm",
          llmAction: serverResult.action,
          backendLabel: serverResult.provider || "Server",
        };
      }
      // Server failed AND user forced "server" — surface the error, no fallback.
      if (effective === "server") {
        return {
          action: null,
          source: "none",
          message: serverResult.error || "Server unreachable",
          backendLabel: "Server (offline)",
        };
      }
      // AUTO path — fall through to local rules.
      const localResult = this.runLocal(input, ctx, serverResult.error);
      if (localResult) return localResult;
      return {
        action: null,
        source: "none",
        message: serverResult.error || "No planner could interpret the task",
      };
    }

    // 2. Pure LOCAL path
    const localResult = this.runLocal(input, ctx);
    if (localResult) return localResult;
    return {
      action: null,
      source: "none",
      message: "Local rules could not interpret the task",
    };
  }

  private runLocal(
    input: LLMPlannerInput,
    ctx: PlanningContext,
    serverError?: string
  ): PlannerResult | null {
    try {
      const a = planAction(input.userPrompt, ctx);
      if (a) {
        return {
          action: a,
          source: "fallback-rules",
          backendLabel: "Local rules",
          message: serverError || "Server unavailable, used local rules",
        };
      }
      return null;
    } catch (e) {
      console.warn("[LLMPlanner] Local rules planner failed:", e);
      return null;
    }
  }

  /**
   * Call the server LLM via the extension bridge.
   * Returns { action, provider, error }. Never throws.
   */
  private async tryServer(
    input: LLMPlannerInput
  ): Promise<{
    action: LLMPlannedAction | null;
    provider?: string;
    error?: string;
  }> {
    const serverUrl = this.config.serverUrl || DEFAULT_PLANNER_CONFIG.serverUrl!;

    // Hard 5 s safety in case the bridge call hangs (it has its own
    // timeout but we belt-and-suspender it here).
    const bridgePromise = planViaServer({
      serverUrl,
      sanitizedDOM: {
        url: input.sanitizedDOM.url,
        title: input.sanitizedDOM.title,
        elements: input.sanitizedDOM.elements as unknown as Array<Record<string, unknown>>,
      },
      userPrompt: input.userPrompt,
      history: (input.history as unknown as Array<Record<string, unknown>>) || [],
    });

    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Server timeout after ${SERVER_TIMEOUT_MS}ms`)),
        SERVER_TIMEOUT_MS
      );
    });

    let result;
    try {
      result = await Promise.race([bridgePromise, timeout]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (timer) clearTimeout(timer);
      return { action: null, error: msg };
    }
    if (timer) clearTimeout(timer);

    if (!result.ok || !result.body) {
      return {
        action: null,
        error: result.error || `Server HTTP ${result.status}`,
      };
    }

    if (result.body.source === "fallback-mock" || result.body.source === "server-llm") {
      const { validateLLMAction } = await import("./action-schema");
      const v = validateLLMAction(result.body.action);
      if (v.ok) {
        return {
          action: v.action,
          provider: result.body.provider || undefined,
        };
      }
      return { action: null, error: `Server returned invalid action: ${v.reason}` };
    }

    return { action: null, error: `Server returned unknown source: ${result.body.source}` };
  }
}

// ----- Default config persistence (chrome.storage.local) -----

const STORAGE_KEY = "rv_agent_config";

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  serverUrl: "http://127.0.0.1:8001",
  onDeviceModel: "onnx-community/Qwen2.5-1.5B-Instruct",
  backend: "auto",
};

export async function loadPlannerConfig(): Promise<PlannerConfig> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored && stored[STORAGE_KEY]) {
      // Merge: defaults first, then stored. Unknown stored fields are
      // dropped silently (forward-compat for users with old configs).
      const merged: PlannerConfig = { ...DEFAULT_PLANNER_CONFIG };
      const s = stored[STORAGE_KEY] as Record<string, unknown>;
      if (typeof s.serverUrl === "string") merged.serverUrl = s.serverUrl;
      if (typeof s.onDeviceModel === "string") merged.onDeviceModel = s.onDeviceModel;
      if (
        s.backend === "auto" ||
        s.backend === "server" ||
        s.backend === "on-device" ||
        s.backend === "local"
      ) {
        merged.backend = s.backend;
      }
      // Intentionally do NOT restore `serverApiKey` — the extension
      // never holds provider API keys.
      return merged;
    }
  } catch {
    /* not in extension context */
  }
  return { ...DEFAULT_PLANNER_CONFIG };
}

export async function savePlannerConfig(config: PlannerConfig): Promise<void> {
  try {
    // Persist ONLY the new shape. No API key, no legacy fields.
    const clean: PlannerConfig = {
      serverUrl: config.serverUrl,
      onDeviceModel: config.onDeviceModel,
      backend: config.backend,
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: clean });
  } catch {
    /* ignore */
  }
}

// Re-export for callers that want to know whether they're in an extension.
export { isInExtensionContext };
