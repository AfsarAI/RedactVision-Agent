/**
 * RedactVision Agent — Background Service Worker
 *
 * Responsibilities:
 *   - Route server-bound requests from popup / content scripts.
 *     This is the ONLY place that calls `fetch()` on the server, so
 *     content scripts (which run in the page's CORS-bound origin)
 *     can still reach the FastAPI server.
 *   - Hold the in-flight message handler for RV_PING_SERVER and
 *     RV_PLAN_ACTION.
 *
 * Privacy contract (CLAUDE.md §4):
 *   - The extension NEVER holds server API keys. The server reads them
 *     from .env and uses them on the user's behalf. The browser only
 *     sends the URL it wants to talk to and the sanitized payload.
 *   - Only sanitized DOM crosses the network boundary.
 */

console.log("RedactVision Agent: Service Worker Loaded");

chrome.runtime.onInstalled.addListener(() => {
  console.log("RedactVision Agent: Installed successfully.");
});

/**
 * Hard ceiling for any single server call.
 *
 * The server's `/llm/plan` may need to walk its multi-provider
 * fallback chain (Gemini → Groq → OpenRouter → NVIDIA → OmniRoute →
 * HF) and on the FIRST cycle of discovery-failed providers the
 * entire chain can take 30–60 s before the server returns 502
 * `llm_unavailable`. We therefore give the client 120 s to wait
 * for a real response (success or structured failure), and treat
 * anything longer than that as a transport-level problem.
 */
const SERVER_TIMEOUT_MS = 120_000;

chrome.runtime.onMessage.addListener(
  (message: { type?: string } & Record<string, unknown>, _sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    // Each handler is async; we return `true` to keep the channel open
    // for the async sendResponse.
    if (message.type === "RV_PING_SERVER") {
      void handlePing(String(message.serverUrl || "")).then(sendResponse);
      return true;
    }

    if (message.type === "RV_PLAN_ACTION") {
      void handlePlan(message as unknown as RVPlanMessage).then(sendResponse);
      return true;
    }

    return false;
  }
);

interface RVPlanMessage {
  type: "RV_PLAN_ACTION";
  serverUrl: string;
  sanitizedDOM: { url: string; title: string; elements: Array<Record<string, unknown>> };
  userPrompt: string;
  history?: Array<Record<string, unknown>>;
}

async function handlePing(serverUrl: string): Promise<unknown> {
  if (!serverUrl) {
    return { ok: false, status: 0, body: null, error: "No server URL configured" };
  }
  const url = `${serverUrl}/llm/health`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    clearTimeout(timer);

    let body: unknown = null;
    try {
      body = await resp.json();
    } catch {
      body = null;
    }
    return { ok: resp.ok, status: resp.status, body };
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      body: null,
      error: isAbort ? `Server timeout after ${SERVER_TIMEOUT_MS}ms` : `Server unreachable: ${msg}`,
    };
  }
}

async function handlePlan(msg: RVPlanMessage): Promise<unknown> {
  const serverUrl = String(msg.serverUrl || "");
  if (!serverUrl) {
    return { ok: false, status: 0, body: null, error: "No server URL configured" };
  }
  const url = `${serverUrl}/llm/plan`;
  const body = {
    url: msg.sanitizedDOM?.url || "",
    title: msg.sanitizedDOM?.title || "",
    elements: msg.sanitizedDOM?.elements || [],
    prompt: msg.userPrompt || "",
    history: msg.history || [],
    timestamp: Date.now(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SERVER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!resp.ok) {
      // Surface structured error bodies (llm_not_configured, etc.) to the client.
      let errorBody: { action: null; source: "error"; code?: string; message?: string } | null = null;
      try {
        const errJson = (await resp.json()) as {
          code?: string;
          message?: string;
          error?: string;
        };
        errorBody = {
          action: null,
          source: "error",
          code: errJson.code,
          message: errJson.message || errJson.error,
        };
      } catch {
        /* not JSON */
      }
      return {
        ok: false,
        status: resp.status,
        body: errorBody as unknown as { action: unknown; source: string } | null,
        error: `HTTP ${resp.status}`,
      };
    }

    let parsed: { action: unknown; source: string } | null = null;
    try {
      parsed = (await resp.json()) as { action: unknown; source: string };
    } catch {
      return { ok: false, status: resp.status, body: null, error: "Invalid JSON" };
    }
    return { ok: true, status: resp.status, body: parsed };
  } catch (e) {
    clearTimeout(timer);
    const errMsg = e instanceof Error ? e.message : String(e);
    const isAbort = e instanceof DOMException && e.name === "AbortError";
    return {
      ok: false,
      status: 0,
      body: null,
      error: isAbort ? `Server timeout after ${SERVER_TIMEOUT_MS}ms` : `Server unreachable: ${errMsg}`,
    };
  }
}
