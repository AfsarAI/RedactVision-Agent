/**
 * RedactVision Agent — Extension Bridge
 *
 * Routes all server calls through the background service worker so that
 * content scripts (which run in the page's origin and are CORS-bound)
 * can still reach the local FastAPI server without CORS errors.
 *
 * Background workers run in the extension's origin and have privileged
 * network access — they can fetch any URL listed in host_permissions
 * without going through the page's CORS policy.
 *
 * If we are NOT running in an extension context (e.g. test harness,
 * dev scripts run with `node`), the bridge falls back to a direct
 * `fetch()` so the same code works everywhere.
 */

export interface PingResult {
  ok: boolean;
  status: number;
  body: unknown;
  /** Human-readable error (e.g. "Server unreachable: connection refused") */
  error?: string;
}

export interface PlanBridgeRequest {
  serverUrl: string;
  sanitizedDOM: {
    url: string;
    title: string;
    elements: Array<Record<string, unknown>>;
  };
  userPrompt: string;
  history?: Array<Record<string, unknown>>;
}

export interface PlanBridgeResult {
  ok: boolean;
  status: number;
  body: {
    action: unknown;
    source: string;
    provider?: string | null;
    model?: string | null;
  } | null;
  error?: string;
}

/** True when we're running inside a Chrome extension context. */
export function isInExtensionContext(): boolean {
  return (
    typeof chrome !== "undefined" &&
    typeof chrome.runtime !== "undefined" &&
    typeof chrome.runtime.sendMessage === "function"
  );
}

/**
 * Ping the server's /llm/health endpoint.
 * Routes through the background worker when available.
 */
export async function pingServer(serverUrl: string): Promise<PingResult> {
  if (isInExtensionContext()) {
    const resp = await chrome.runtime.sendMessage({
      type: "RV_PING_SERVER",
      serverUrl,
    });
    return resp as PingResult;
  }
  return pingServerDirect(serverUrl);
}

/**
 * Ask the server to plan the next action.
 * Routes through the background worker when available.
 */
export async function planViaServer(
  req: PlanBridgeRequest
): Promise<PlanBridgeResult> {
  if (isInExtensionContext()) {
    const resp = await chrome.runtime.sendMessage({
      type: "RV_PLAN_ACTION",
      ...req,
    });
    return resp as PlanBridgeResult;
  }
  return planViaServerDirect(req);
}

// ----- Direct-fetch fallbacks (used by tests / non-extension contexts) -----

async function pingServerDirect(serverUrl: string): Promise<PingResult> {
  try {
    const resp = await fetch(`${serverUrl}/llm/health`);
    const body = await resp.json().catch(() => ({}));
    return { ok: resp.ok, status: resp.status, body };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function planViaServerDirect(
  req: PlanBridgeRequest
): Promise<PlanBridgeResult> {
  try {
    const resp = await fetch(`${req.serverUrl}/llm/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: req.sanitizedDOM.url,
        title: req.sanitizedDOM.title,
        elements: req.sanitizedDOM.elements,
        prompt: req.userPrompt,
        history: req.history || [],
        timestamp: Date.now(),
      }),
    });
    if (!resp.ok) {
      return {
        ok: false,
        status: resp.status,
        body: null,
        error: `HTTP ${resp.status}`,
      };
    }
    const body = (await resp.json()) as {
      action: unknown;
      source: string;
      provider?: string | null;
      model?: string | null;
    };
    return { ok: true, status: resp.status, body };
  } catch (e) {
    return {
      ok: false,
      status: 0,
      body: null,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
