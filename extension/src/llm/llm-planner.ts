/**
 * RedactVision Agent — Planner Orchestrator (server-LLM only)
 *
 * ARCHITECTURE (CLAUDE.md §5, §18):
 *   - The SERVER-SIDE LLM is the SOLE planner.
 *   - The client NEVER interprets natural-language prompts via
 *     hardcoded grammar, regex, keyword matching, or "fallback
 *     rules". All natural-language understanding belongs to the
 *     server's LLM.
 *   - The on-device model is a perception/sanitization helper inside
 *     the Privacy Firewall. It is NOT a planner.
 *
 * Routing is controlled by `PlannerConfig.backend`:
 *   - "server"     (default) — call the server's /llm/plan endpoint.
 *     This is the only supported planner. The client never makes
 *     action decisions locally.
 *   - "auto"/"local"/"on-device" — kept as accepted values for
 *     backward-compat with stored popup config; all map to "server"
 *     because there is no other planner in the architecture.
 *
 * The user configures:
 *   - serverUrl      (where to POST)
 *   - onDeviceModel  (model id for the privacy firewall's visual PII
 *                     detector; not used by this orchestrator)
 *   - backend        (routing override; mapped to "server" below)
 *
 * NOTE: The extension never holds the server's API key. The server
 * reads provider keys (Gemini, Groq, etc.) from its own .env and uses
 * them on the user's behalf.
 */

import type { PlannedAction } from "../executor/action-executor";
import {
  LLMPlannedAction,
  LLMPlannerInput,
  ActionHistoryEntry,
  toExecutorAction,
} from "./action-schema";
import { planViaServer } from "./extension-bridge";

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
   * Routing override. The ONLY supported planner is the server LLM.
   * "auto" / "local" / "on-device" are accepted for backward-compat
   * with stored popup config and are mapped to "server" internally.
   */
  backend?: PlannerBackend;
}

/**
 * Source of the action. The architecture is server-LLM-only, so the
 * only "happy" source is "server-llm". "none" is used when the
 * server is unreachable or the LLM is not configured.
 *
 * The historical "fallback-rules" value is kept ONLY so that stored
 * UI labels and analytics don't break; it is no longer produced.
 */
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
  /**
   * A short error code (e.g. "llm_not_configured", "llm_unavailable",
   * "server_unreachable") for the UI to switch into a specific state.
   * Only present when source === "none".
   */
  errorCode?: string;
}

/**
 * Hard ceiling for any single server call. Matches the service
 * worker. The server's `/llm/plan` may walk a multi-provider
 * fallback chain before returning, so we wait up to 120 s.
 */
const SERVER_TIMEOUT_MS = 120_000;

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
   * Plan the next action by delegating to the server LLM.
   *
   * The client does NOT contain any fallback planner. When the server
   * is unreachable or the LLM is not configured, this method returns
   * `source: "none"` with an explanatory message and an `errorCode`
   * so the UI can show a clear "Agent offline" state instead of
   * silently inventing a hardcoded action.
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
    // The ONLY supported planner is the server LLM. Any legacy
    // routing value collapses to "server" here.
    void ctx;

    const serverResult = await this.tryServer(input);
    if (serverResult.action) {
      return {
        action: toExecutorAction(serverResult.action),
        source: "server-llm",
        llmAction: serverResult.action,
        backendLabel: serverResult.provider || "Server",
      };
    }
    return {
      action: null,
      source: "none",
      message: serverResult.error || "Server did not return a valid action",
      backendLabel: serverResult.provider || "Server (offline)",
      errorCode: serverResult.errorCode,
    };
  }

  /**
   * Call the server LLM via the extension bridge.
   * Returns { action, provider, error, errorCode }. Never throws.
   */
  private async tryServer(
    input: LLMPlannerInput
  ): Promise<{
    action: LLMPlannedAction | null;
    provider?: string;
    error?: string;
    errorCode?: string;
  }> {
    const serverUrl = this.config.serverUrl || DEFAULT_PLANNER_CONFIG.serverUrl!;

    // Trim the sanitized DOM to keep the request small enough that
    // even providers with strict body limits (e.g. Groq's 413 cap)
    // will accept it. We keep at most MAX_ELEMENTS elements and
    // strip noisy fields like long CSS classes.
    const trimmedElements = trimElements(
      input.sanitizedDOM.elements as unknown as Array<Record<string, unknown>>
    );

    const bridgePromise = planViaServer({
      serverUrl,
      sanitizedDOM: {
        url: input.sanitizedDOM.url,
        title: input.sanitizedDOM.title,
        elements: trimmedElements,
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

    let result: Awaited<typeof bridgePromise>;
    try {
      result = await Promise.race([bridgePromise, timeout]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (timer) clearTimeout(timer);
      return { action: null, error: msg, errorCode: "server_unreachable" };
    }
    if (timer) clearTimeout(timer);

    if (!result.ok || !result.body) {
      return {
        action: null,
        error: result.error || `Server HTTP ${result.status}`,
        errorCode: classifyHttpError(result.status),
      };
    }

    // Server returned an error JSON (e.g. llm_not_configured / llm_unavailable).
    if (result.body.source === "error") {
      return {
        action: null,
        error:
          (result.body as unknown as { message?: string }).message ||
          "Server reported an error",
        errorCode:
          (result.body as unknown as { code?: string }).code || "server_error",
      };
    }

    if (result.body.source === "server-llm") {
      const { validateLLMAction } = await import("./action-schema");
      const v = validateLLMAction(result.body.action);
      if (v.ok) {
        return {
          action: v.action,
          provider: result.body.provider || undefined,
        };
      }
      return {
        action: null,
        error: `Server returned invalid action: ${v.reason}`,
        errorCode: "invalid_action",
      };
    }

    return {
      action: null,
      error: `Server returned unknown source: ${result.body.source}`,
      errorCode: "server_error",
    };
  }
}

function classifyHttpError(status: number): string {
  if (status === 503) return "llm_not_configured";
  if (status === 502) return "llm_unavailable";
  if (status === 0) return "server_unreachable";
  return "server_error";
}

/**
 * Trim a sanitized DOM before sending it to the server LLM.
 *
 * Some real-world pages (and even the local test page) include
 * hundreds of `a`, `img`, `[role]`, `[aria-label]` elements which
 * blow past providers' body-size limits (Groq returns 413 above
 * ~1 MB). We keep only the elements that the agent can actually
 * act on, drop noisy fields, and cap the total at MAX_ELEMENTS.
 */
const MAX_ELEMENTS = 50;
const MAX_TEXT_CHARS = 80;

const ACTIVE_TAGS = new Set([
  "input",
  "textarea",
  "select",
  "button",
  "form",
  "a",
]);

function trimElements(
  elements: Array<Record<string, unknown>>
): Array<Record<string, unknown>> {
  if (!Array.isArray(elements)) return [];

  const out: Array<Record<string, unknown>> = [];
  for (const el of elements) {
    const tag = String(el.tag || "").toLowerCase();
    const hasRole = typeof el.role === "string" && el.role.length > 0;
    const hasAria = typeof el.ariaLabel === "string" && el.ariaLabel.length > 0;
    if (!ACTIVE_TAGS.has(tag) && !hasRole && !hasAria) continue;

    const clean: Record<string, unknown> = { tag };
    if (typeof el.id === "string" && el.id) clean.id = el.id;
    if (typeof el.type === "string" && el.type) clean.type = el.type;
    if (typeof el.name === "string" && el.name) clean.name = el.name;
    if (typeof el.placeholder === "string" && el.placeholder) clean.placeholder = el.placeholder;
    if (typeof el.ariaLabel === "string" && el.ariaLabel) clean.ariaLabel = el.ariaLabel;
    if (typeof el.value === "string") clean.value = el.value;
    if (typeof el.text === "string") {
      clean.text = el.text.length > MAX_TEXT_CHARS ? el.text.slice(0, MAX_TEXT_CHARS) : el.text;
    }
    if (typeof el.selector === "string" && el.selector) clean.selector = el.selector;

    out.push(clean);
    if (out.length >= MAX_ELEMENTS) break;
  }
  return out;
}

// ----- Default config persistence (chrome.storage.local) -----

const STORAGE_KEY = "rv_agent_config";

export const DEFAULT_PLANNER_CONFIG: PlannerConfig = {
  serverUrl: "http://127.0.0.1:8001",
  onDeviceModel: "onnx-community/Qwen2.5-1.5B-Instruct",
  backend: "server",
};

export async function loadPlannerConfig(): Promise<PlannerConfig> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    if (stored && stored[STORAGE_KEY]) {
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
        // Any legacy value is accepted and treated as "server" — the
        // only supported planner. We keep the user's value in the
        // stored config for backward-compat, but force "server"
        // internally at runtime.
        merged.backend = "server";
      }
      return merged;
    }
  } catch {
    /* not in extension context */
  }
  return { ...DEFAULT_PLANNER_CONFIG };
}

export async function savePlannerConfig(config: PlannerConfig): Promise<void> {
  try {
    // Always persist as "server" — no other planner exists.
    const clean: PlannerConfig = {
      serverUrl: config.serverUrl,
      onDeviceModel: config.onDeviceModel,
      backend: "server",
    };
    await chrome.storage.local.set({ [STORAGE_KEY]: clean });
  } catch {
    /* ignore */
  }
}

// Re-export for callers that want to know whether they're in an extension.
export { isInExtensionContext } from "./extension-bridge";

// Re-imported to satisfy the PlannerContext type alias used above.
import type { PlanningContext } from "../agent/action-planner";
