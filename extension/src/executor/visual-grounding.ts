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
  serverUrl = "http://13.49.49.25:8001"
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

export interface TextSpatialRegion {
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  element?: Element;
}

/**
 * Scan all visible text regions across the viewport with accurate bounding coordinates.
 * Functions as an on-device instant OCR text map.
 */
export function scanViewportTextRegions(): TextSpatialRegion[] {
  const regions: TextSpatialRegion[] = [];
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (!node.textContent || !node.textContent.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        const tag = parent.tagName.toLowerCase();
        if (tag === "script" || tag === "style" || tag === "noscript") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    }
  );

  let currentNode = walker.nextNode();
  while (currentNode) {
    const parent = currentNode.parentElement;
    if (parent) {
      const rect = parent.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.top <= (window.innerHeight || 800)) {
        const text = (currentNode.textContent || "").trim();
        if (text.length > 0) {
          regions.push({
            text,
            x: Math.round(rect.left),
            y: Math.round(rect.top),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
            element: parent,
          });
        }
      }
    }
    currentNode = walker.nextNode();
  }

  return regions;
}

/**
 * Locate exact (x, y) coordinates for a field or button using the OCR spatial text map.
 */
export function locateOCRSpatialCoordinates(
  targetDescription: string,
  isInput = false
): { clientX: number; clientY: number; element?: Element } | null {
  const regions = scanViewportTextRegions();
  const query = targetDescription.toLowerCase().replace(/[^a-z0-9\s]/g, " ").trim();
  const queryTerms = query.split(/\s+/).filter((t) => t.length > 2);

  let bestRegion: TextSpatialRegion | null = null;
  let bestScore = -1;

  for (const region of regions) {
    const textLower = region.text.toLowerCase();
    let score = 0;

    if (textLower === query) {
      score += 100;
    } else if (textLower.includes(query) || query.includes(textLower)) {
      score += 50;
    } else {
      for (const term of queryTerms) {
        if (textLower.includes(term)) score += 20;
      }
    }

    if (score > bestScore) {
      bestScore = score;
      bestRegion = region;
    }
  }

  if (!bestRegion || bestScore < 10) return null;

  if (isInput) {
    // For inputs: target is positioned directly underneath the label text or to the right
    const probeX = Math.round(bestRegion.x + 20);
    const probeY = Math.round(bestRegion.y + bestRegion.height + 25);

    // Check if an input element exists at that point
    const foundEl = document.elementFromPoint(probeX, probeY);
    if (foundEl) {
      const rect = foundEl.getBoundingClientRect();
      return {
        clientX: Math.round(rect.left + Math.min(40, rect.width / 2)),
        clientY: Math.round(rect.top + rect.height / 2),
        element: foundEl,
      };
    }

    return { clientX: probeX, clientY: probeY, element: bestRegion.element };
  } else {
    // For buttons / links: target center of text region
    return {
      clientX: Math.round(bestRegion.x + bestRegion.width / 2),
      clientY: Math.round(bestRegion.y + bestRegion.height / 2),
      element: bestRegion.element,
    };
  }
}

/**
 * Multimodal Visual Fallback Click Handler:
 * When DOM lookup fails, locates the target text via OCR spatial map,
 * glides the visual cursor to (x, y), and dispatches CDP click.
 */
export async function handleFallbackVisualClick(
  targetDescription: string,
  serverUrl = "http://13.49.49.25:8001"
): Promise<boolean> {
  console.log(`[VisualGrounding] Initiating OCR spatial lookup for: "${targetDescription}"`);
  setCursorBadge(`Locating "${targetDescription.slice(0, 15)}" via OCR…`);

  // 1. Try instant OCR spatial text map first
  const ocrMatch = locateOCRSpatialCoordinates(targetDescription, false);
  if (ocrMatch) {
    setCursorBadge(`Target located`);
    await moveCustomCursor(ocrMatch.clientX, ocrMatch.clientY, 400);
    setCursorBadge(`Clicking…`);
    await executeCDPClick(ocrMatch.clientX, ocrMatch.clientY);
    await new Promise((r) => setTimeout(r, 120));
    setCursorBadge(null);
    return true;
  }

  // 2. VLM Screenshot grounding fallback
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
 * Locates the target input visually via OCR spatial coordinates, glides cursor, clicks, and types text via CDP.
 */
export async function handleFallbackVisualType(
  targetDescription: string,
  text: string,
  serverUrl = "http://13.49.49.25:8001"
): Promise<boolean> {
  console.log(`[VisualGrounding] Initiating OCR spatial lookup for input: "${targetDescription}"`);
  setCursorBadge(`Locating field via OCR…`);

  // 1. Try instant OCR spatial text map first
  const ocrMatch = locateOCRSpatialCoordinates(targetDescription, true);
  if (ocrMatch) {
    setCursorBadge(`Field located`);
    await moveCustomCursor(ocrMatch.clientX, ocrMatch.clientY, 380);
    setCursorBadge(`Typing…`);
    await executeCDPType(ocrMatch.clientX, ocrMatch.clientY, text);
    await new Promise((r) => setTimeout(r, 120));
    setCursorBadge(null);
    return true;
  }

  // 2. VLM Screenshot grounding fallback
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

  await moveCustomCursor(clientX, clientY, 380);
  setCursorBadge(`Typing…`);
  await executeCDPType(clientX, clientY, text);

  await new Promise((r) => setTimeout(r, 120));
  setCursorBadge(null);
  return true;
}
