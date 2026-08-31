/**
 * RedactVision Agent — Multimodal Vision-Language Fallback Engine
 *
 * Technical Specification implementation:
 * When standard DOM traversal, XPath evaluation, or ARIA-role mapping fails
 * (due to opaque canvas elements, custom WebGL interfaces, heavy obfuscation,
 * or broken semantic structures), the agent shifts from Structural Reasoning
 * to Visual Grounding:
 *
 *   [ DOM Failure / Custom Canvas / Rich WebApp ]
 *          │
 *          ▼
 *   [ Step 1: Viewport Capture ] (chrome.tabs.captureVisibleTab)
 *          │
 *          ▼
 *   [ Step 2: VLM Visual Grounding ] (VLM -> Normalized [0-1000] Box & Point)
 *          │
 *          ▼
 *   [ Step 3: Coordinate Denormalization ] (scale to viewport pixels)
 *          │
 *          ▼
 *   [ Step 4: Visual Cursor Glide ] (smooth human cursor travel)
 *          │
 *          ▼
 *   [ Step 5: High-Precision CDP Execution ] (CDP Input.dispatchMouseEvent / insertText)
 */

import {
  moveCustomCursor,
  triggerClickRipple,
  setCursorBadge,
} from "./visual-cursor";

export interface NormalizedCoordinates {
  found: boolean;
  point?: [number, number]; // [x, y] in [0, 1000]
  box_2d?: [number, number, number, number]; // [ymin, xmin, ymax, xmax]
  description?: string;
}

export interface ViewportMetrics {
  width: number;
  height: number;
  devicePixelRatio: number;
  scrollX: number;
  scrollY: number;
}

/**
 * Capture current visible viewport layout as a data URL via background service worker.
 */
export async function captureViewport(): Promise<string | null> {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const resp = (await chrome.runtime.sendMessage({
        type: "RV_CAPTURE_VISIBLE_TAB",
      })) as { ok: boolean; dataUrl?: string };
      if (resp?.ok && resp.dataUrl) {
        return resp.dataUrl;
      }
    }
  } catch (e) {
    console.warn("[VisualGrounding] Viewport capture error:", e);
  }
  return null;
}

/**
 * Query the server's VLM visual grounding endpoint to locate an interactive element visually.
 */
export async function queryVisionModel(
  base64Image: string,
  targetDescription: string,
  serverUrl = "http://127.0.0.1:8001"
): Promise<NormalizedCoordinates> {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const resp = (await chrome.runtime.sendMessage({
        type: "RV_VISUAL_GROUND",
        serverUrl,
        image: base64Image,
        targetDescription,
      })) as { ok: boolean; result?: NormalizedCoordinates };

      if (resp?.ok && resp.result) {
        return resp.result;
      }
    }

    // Direct fetch fallback for non-extension environments
    const directResp = await fetch(`${serverUrl}/llm/visual-ground`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        image: base64Image,
        target_description: targetDescription,
      }),
    });

    if (directResp.ok) {
      return (await directResp.json()) as NormalizedCoordinates;
    }
  } catch (e) {
    console.warn("[VisualGrounding] VLM query error:", e);
  }

  return { found: false };
}

/**
 * Get current browser viewport metrics for accurate pixel scaling.
 */
export function getViewportMetrics(): ViewportMetrics {
  return {
    width: window.innerWidth || document.documentElement.clientWidth || 1280,
    height: window.innerHeight || document.documentElement.clientHeight || 800,
    devicePixelRatio: window.devicePixelRatio || 1,
    scrollX: window.scrollX || window.pageXOffset || 0,
    scrollY: window.scrollY || window.pageYOffset || 0,
  };
}

/**
 * Map normalized VLM points [0-1000] to exact physical viewport pixels.
 */
export function denormalizeCoordinates(
  normalizedPoint: [number, number],
  viewport: ViewportMetrics
): { clientX: number; clientY: number } {
  const [normX, normY] = normalizedPoint;

  // Scale from 1000-grid to actual client viewport pixels
  const clientX = Math.round((normX / 1000) * viewport.width);
  const clientY = Math.round((normY / 1000) * viewport.height);

  return { clientX, clientY };
}

/**
 * Execute a low-level physical click via Chrome DevTools Protocol (CDP).
 */
export async function executeCDPClick(
  clientX: number,
  clientY: number
): Promise<boolean> {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const resp = (await chrome.runtime.sendMessage({
        type: "RV_CDP_CLICK",
        x: clientX,
        y: clientY,
      })) as { ok: boolean; error?: string };

      if (resp?.ok) return true;
    }
  } catch (e) {
    console.warn("[VisualGrounding] CDP click failed, falling back:", e);
  }

  // Seamless in-page fallback
  triggerClickRipple(clientX, clientY);
  const target = document.elementFromPoint(clientX, clientY);
  if (target) {
    const events = ["mousedown", "mouseup", "click"];
    for (const evt of events) {
      target.dispatchEvent(
        new MouseEvent(evt, {
          view: window,
          bubbles: true,
          cancelable: true,
          clientX,
          clientY,
        })
      );
    }
    if (target instanceof HTMLElement) target.focus();
    return true;
  }

  return false;
}

/**
 * Execute a low-level physical text type via Chrome DevTools Protocol (CDP).
 */
export async function executeCDPType(
  clientX: number,
  clientY: number,
  text: string
): Promise<boolean> {
  try {
    if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
      const resp = (await chrome.runtime.sendMessage({
        type: "RV_CDP_TYPE",
        x: clientX,
        y: clientY,
        text,
      })) as { ok: boolean; error?: string };

      if (resp?.ok) return true;
    }
  } catch (e) {
    console.warn("[VisualGrounding] CDP type failed, falling back:", e);
  }

  // Fallback for rich text editors
  const target = document.elementFromPoint(clientX, clientY);
  if (target instanceof HTMLElement) {
    target.focus();
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
      target.value = text;
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      document.execCommand?.("insertText", false, text);
    }
    return true;
  }

  return false;
}

/**
 * Multimodal Visual Fallback Click Handler:
 * When DOM lookup fails, captures the viewport screenshot, queries the VLM
 * for spatial coordinates, glides the visual cursor there, and dispatches CDP click.
 */
export async function handleFallbackVisualClick(
  targetDescription: string,
  serverUrl = "http://127.0.0.1:8001"
): Promise<boolean> {
  console.log(`[VisualGrounding] Initiating VLM visual fallback for: "${targetDescription}"`);
  setCursorBadge(`Scanning screen visually…`);

  const screenshot = await captureViewport();
  if (!screenshot) {
    console.warn("[VisualGrounding] Could not capture viewport for visual fallback");
    setCursorBadge(null);
    return false;
  }

  const vlmResult = await queryVisionModel(screenshot, targetDescription, serverUrl);
  if (!vlmResult.found || !vlmResult.point) {
    console.warn(`[VisualGrounding] VLM could not visually locate: "${targetDescription}"`);
    setCursorBadge(null);
    return false;
  }

  const metrics = getViewportMetrics();
  const { clientX, clientY } = denormalizeCoordinates(vlmResult.point, metrics);

  setCursorBadge(`Target located`);
  await moveCustomCursor(clientX, clientY, 400);

  setCursorBadge(`Clicking…`);
  await executeCDPClick(clientX, clientY);

  await new Promise((r) => setTimeout(r, 120));
  setCursorBadge(null);
  return true;
}

/**
 * Multimodal Visual Fallback Type Handler:
 * Locates the target input visually, glides cursor, clicks, and types text via CDP.
 */
export async function handleFallbackVisualType(
  targetDescription: string,
  text: string,
  serverUrl = "http://127.0.0.1:8001"
): Promise<boolean> {
  console.log(`[VisualGrounding] Initiating VLM visual fallback type for: "${targetDescription}"`);
  setCursorBadge(`Scanning input visually…`);

  const screenshot = await captureViewport();
  if (!screenshot) {
    setCursorBadge(null);
    return false;
  }

  const vlmResult = await queryVisionModel(screenshot, targetDescription, serverUrl);
  if (!vlmResult.found || !vlmResult.point) {
    setCursorBadge(null);
    return false;
  }

  const metrics = getViewportMetrics();
  const { clientX, clientY } = denormalizeCoordinates(vlmResult.point, metrics);

  await moveCustomCursor(clientX, clientY, 400);
  setCursorBadge(`Typing…`);

  await executeCDPType(clientX, clientY, text);

  await new Promise((r) => setTimeout(r, 120));
  setCursorBadge(null);
  return true;
}
