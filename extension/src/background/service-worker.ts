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
 *   - Capture visible-tab screenshots for local visual perception.
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
  (message: { type?: string } & Record<string, unknown>, sender, sendResponse) => {
    if (!message || typeof message.type !== "string") return false;

    const tabId = sender.tab?.id;

    if (message.type === "RV_PING_SERVER") {
      void handlePing(String(message.serverUrl || ""))
        .then(sendResponse)
        .catch((err) => {
          console.error("[RedactVision] Service Worker: Ping handler error:", err);
          sendResponse({
            ok: false,
            status: 0,
            body: null,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }

    if (message.type === "RV_PLAN_ACTION") {
      void handlePlan(message as unknown as RVPlanMessage)
        .then(sendResponse)
        .catch((err) => {
          console.error("[RedactVision] Service Worker: Plan handler error:", err);
          sendResponse({
            ok: false,
            status: 0,
            body: null,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true;
    }

    if (message.type === "RV_CAPTURE_VISIBLE_TAB" || message.type === "RV_CAPTURE_VIEWPORT") {
      void handleCaptureVisibleTab().then(sendResponse);
      return true;
    }

    if (message.type === "RV_CDP_CLICK") {
      const x = Number(message.x) || 0;
      const y = Number(message.y) || 0;
      void handleCDPClick(tabId, x, y).then(sendResponse);
      return true;
    }

    if (message.type === "RV_CDP_TYPE") {
      const x = Number(message.x) || 0;
      const y = Number(message.y) || 0;
      const text = String(message.text || "");
      void handleCDPType(tabId, x, y, text).then(sendResponse);
      return true;
    }

    if (message.type === "RV_CDP_KEY") {
      const key = String(message.key || "Enter");
      const code = String(message.code || "Enter");
      const keyCode = Number(message.keyCode) || 13;
      void handleCDPKey(tabId, key, code, keyCode).then(sendResponse);
      return true;
    }

    if (message.type === "RV_VISUAL_GROUND") {
      const serverUrl = String(message.serverUrl || "http://13.49.49.25:8001");
      const image = String(message.image || "");
      const targetDescription = String(message.targetDescription || "");
      void handleVisualGround(serverUrl, image, targetDescription).then(sendResponse);
      return true;
    }

    if (message.type === "RV_OPEN_TAB") {
      const url = String(message.url || "about:blank");
      const active = Boolean(message.active ?? false);
      void handleOpenTab(url, active).then(sendResponse);
      return true;
    }

    if (message.type === "RV_NAVIGATE_TAB") {
      const targetTabId = Number(message.tabId) || tabId || 0;
      const url = String(message.url || "");
      void handleNavigateTab(targetTabId, url).then(sendResponse);
      return true;
    }

    if (message.type === "RV_CLOSE_TAB") {
      const targetTabId = Number(message.tabId) || 0;
      void handleCloseTab(targetTabId).then(sendResponse);
      return true;
    }

    if (message.type === "RV_RUN_SUBAGENT_TAB") {
      const targetTabId = Number(message.tabId) || 0;
      const subagentPrompt = String(message.prompt || "");
      void handleRunSubagentOnTab(targetTabId, subagentPrompt).then(sendResponse);
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

async function handleCaptureVisibleTab(): Promise<unknown> {
  try {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "png" });
    if (!dataUrl) {
      return { ok: false, dataUrl: null, width: 0, height: 0, error: "No screenshot returned" };
    }
    const dimensions = await readImageDimensions(dataUrl);
    return { ok: true, dataUrl, ...dimensions };
  } catch (e) {
    return {
      ok: false,
      dataUrl: null,
      width: 0,
      height: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

async function readImageDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  const bitmap = await createImageBitmap(blob);
  const dimensions = { width: bitmap.width, height: bitmap.height };
  bitmap.close();
  return dimensions;
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

// ===================================================================
// Chrome DevTools Protocol (CDP) Low-Level Input Execution
// ===================================================================

async function getTargetTabId(callerTabId?: number): Promise<number | null> {
  if (typeof callerTabId === "number" && callerTabId > 0) {
    return callerTabId;
  }
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

/**
 * Execute a low-level physical mouse click sequence via CDP.
 * Bypasses synthetic event barriers (React, Vue, Lexical, ProseMirror, Canvas, WebGL).
 */
async function handleCDPClick(tabId?: number, x = 0, y = 0): Promise<{ ok: boolean; error?: string }> {
  const targetTabId = await getTargetTabId(tabId);
  if (!targetTabId) {
    return { ok: false, error: "No active tab found for CDP execution" };
  }

  const target = { tabId: targetTabId };

  try {
    // 1. Attach debugger protocol safely
    await chrome.debugger.attach(target, "1.3");

    // 2. Dispatch mouseMoved event
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: Math.round(x),
      y: Math.round(y),
    });

    // 3. Mouse Down (mousePressed)
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });

    // Human-like delay
    await new Promise((res) => setTimeout(res, 80));

    // 4. Mouse Up (mouseReleased)
    await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: Math.round(x),
      y: Math.round(y),
      button: "left",
      clickCount: 1,
    });

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[ServiceWorker] CDP Click failed:", msg);
    return { ok: false, error: msg };
  } finally {
    // 5. Always detach cleanly
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/**
 * Execute real physical text typing via CDP Input.insertText & Input.dispatchKeyEvent.
 * Dispatches real native input into rich editors (ChatGPT, Claude, Lexical, Slate, Monaco).
 */
async function handleCDPType(
  tabId?: number,
  x = 0,
  y = 0,
  text = ""
): Promise<{ ok: boolean; error?: string }> {
  const targetTabId = await getTargetTabId(tabId);
  if (!targetTabId) {
    return { ok: false, error: "No active tab found for CDP typing" };
  }

  const target = { tabId: targetTabId };

  try {
    await chrome.debugger.attach(target, "1.3");

    // Click at coordinates to focus the target element
    if (x > 0 && y > 0) {
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: Math.round(x),
        y: Math.round(y),
        button: "left",
        clickCount: 1,
      });
      await new Promise((res) => setTimeout(res, 40));
      await chrome.debugger.sendCommand(target, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: Math.round(x),
        y: Math.round(y),
        button: "left",
        clickCount: 1,
      });
      await new Promise((res) => setTimeout(res, 60));
    }

    // 2. Select All (Cmd+A / Ctrl+A) to clear any pre-filled or placeholder residue
    const isMac = typeof navigator !== "undefined" && navigator.platform.toUpperCase().indexOf("MAC") >= 0;
    const modifier = isMac ? 8 : 2; // 8 = Command key (Mac), 2 = Control key (Windows/Linux)

    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode: 65,
      code: "KeyA",
      key: "a",
      modifiers: modifier,
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 65,
      code: "KeyA",
      key: "a",
    });

    // 3. Erase selected text (Backspace)
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      windowsVirtualKeyCode: 8,
      code: "Backspace",
      key: "Backspace",
    });
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      windowsVirtualKeyCode: 8,
      code: "Backspace",
      key: "Backspace",
    });

    await new Promise((res) => setTimeout(res, 40));

    // 4. Use Input.insertText for authentic, clean insertion into rich text / React editors
    await chrome.debugger.sendCommand(target, "Input.insertText", {
      text,
    });

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[ServiceWorker] CDP Type failed:", msg);
    return { ok: false, error: msg };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/**
 * Dispatch keyboard events (e.g. Enter key) via CDP.
 */
async function handleCDPKey(
  tabId?: number,
  key = "Enter",
  code = "Enter",
  keyCode = 13
): Promise<{ ok: boolean; error?: string }> {
  const targetTabId = await getTargetTabId(tabId);
  if (!targetTabId) {
    return { ok: false, error: "No active tab found for CDP key execution" };
  }

  const target = { tabId: targetTabId };

  try {
    await chrome.debugger.attach(target, "1.3");

    // Key Down
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });

    await new Promise((res) => setTimeout(res, 50));

    // Key Up
    await chrome.debugger.sendCommand(target, "Input.dispatchKeyEvent", {
      type: "keyUp",
      key,
      code,
      windowsVirtualKeyCode: keyCode,
    });

    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[ServiceWorker] CDP Key failed:", msg);
    return { ok: false, error: msg };
  } finally {
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/**
 * Call the server's visual grounding endpoint to locate elements on a screenshot.
 */
async function handleVisualGround(
  serverUrl: string,
  image: string,
  targetDescription: string
): Promise<{ ok: boolean; result?: { found: boolean; point?: [number, number]; box_2d?: [number, number, number, number] }; error?: string }> {
  try {
    const resp = await fetch(`${serverUrl}/llm/visual-ground`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image,
        target_description: targetDescription,
      }),
    });

    if (!resp.ok) {
      return { ok: false, error: `HTTP ${resp.status}` };
    }

    const data = await resp.json();
    return { ok: true, result: data };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}

// ===================================================================
// Multi-Tab & Fan-Out Subagent Orchestration
// ===================================================================

/**
 * Create a new Chrome tab and wait for page load to complete.
 */
async function handleOpenTab(url: string, active = false): Promise<{ ok: boolean; tabId?: number; error?: string }> {
  try {
    const tab = await chrome.tabs.create({ url, active });
    if (!tab.id) return { ok: false, error: "Tab creation failed" };

    // Wait for the tab to reach 'complete' status
    await waitForTabComplete(tab.id);
    return { ok: true, tabId: tab.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Navigate a specific tab to a new URL and wait for load.
 */
async function handleNavigateTab(tabId: number, url: string): Promise<{ ok: boolean; error?: string }> {
  try {
    await chrome.tabs.update(tabId, { url });
    await waitForTabComplete(tabId);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Close a specific tab.
 */
async function handleCloseTab(tabId: number): Promise<{ ok: boolean }> {
  try {
    if (tabId > 0) {
      await chrome.tabs.remove(tabId);
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

/**
 * Wait for a tab's document to reach 'complete' status.
 */
function waitForTabComplete(tabId: number, timeoutMs = 25000): Promise<void> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve();
      }
    };

    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (timer) clearTimeout(timer);
    };

    timer = setTimeout(() => {
      cleanup();
      resolve(); // resolve on timeout rather than hanging
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);
  });
}

/**
 * Dispatch a subagent task to an open tab's content script.
 */
async function handleRunSubagentOnTab(
  tabId: number,
  prompt: string
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  try {
    const resp = await chrome.tabs.sendMessage(tabId, {
      type: "RV_EXECUTE_SUBAGENT_PROMPT",
      prompt,
    });
    return { ok: true, result: resp };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

