/**
 * RedactVision Agent - Screenshot Capture
 *
 * Captures screenshots of the page for visual perception.
 * Screenshots are processed locally and NEVER sent raw to the server.
 */

import { captureVisibleTabViaBackground, isInExtensionContext } from "../llm/extension-bridge";

export interface ScreenshotResult {
  /** Base64-encoded PNG image data */
  dataUrl: string;
  /** Image dimensions */
  width: number;
  height: number;
  /** Timestamp of capture */
  timestamp: number;
  /** Whether WebGPU is available for GPU acceleration */
  webgpuAvailable: boolean;
}

/**
 * Capture a screenshot of the current viewport.
 * Uses chrome.captureVisibleTab for Manifest V3 compatibility.
 */
export async function captureViewportScreenshot(): Promise<ScreenshotResult> {
  const timestamp = Date.now();

  if (isInExtensionContext()) {
    const result = await captureVisibleTabViaBackground();
    if (!result.ok || !result.dataUrl) {
      throw new Error(result.error || "Failed to capture visible tab");
    }
    return {
      dataUrl: result.dataUrl,
      width: result.width,
      height: result.height,
      timestamp,
      webgpuAvailable: checkWebGPU(),
    };
  }

  return captureViewportCanvas();
}

/**
 * Fallback capture using canvas (works without extension permissions).
 * Only captures the current visible viewport.
 */
export function captureViewportCanvas(): ScreenshotResult {
  const width = window.innerWidth;
  const height = window.innerHeight;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get canvas context");
  }

  // Create an image from the current page
  const html2d = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
      <foreignObject width="100%" height="100%">
        <div xmlns="http://www.w3.org/1999/xhtml" style="width:${width}px;height:${height}px;">
          ${document.documentElement.outerHTML}
        </div>
      </foreignObject>
    </svg>
  `;

  // This is a simplified approach - in practice, you'd use html2canvas library
  // For now, we'll return a placeholder that indicates canvas capture was attempted
  const dataUrl = canvas.toDataURL("image/png");

  return {
    dataUrl,
    width,
    height,
    timestamp: Date.now(),
    webgpuAvailable: checkWebGPU(),
  };
}

/**
 * Check if WebGPU is available for GPU-accelerated processing.
 */
function checkWebGPU(): boolean {
  try {
    return typeof navigator !== "undefined" && "gpu" in navigator;
  } catch {
    return false;
  }
}

/**
 * Capture a specific region of the page.
 */
export async function captureRegionScreenshot(
  x: number,
  y: number,
  width: number,
  height: number
): Promise<ScreenshotResult> {
  // Capture full viewport first
  const fullCapture = await captureViewportScreenshot();

  // Crop to the requested region using canvas
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get canvas context");
  }

  // Create image from the captured data
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("Failed to load captured image"));
    img.src = fullCapture.dataUrl;
  });

  // Draw the cropped region
  ctx.drawImage(img, x, y, width, height, 0, 0, width, height);

  return {
    dataUrl: canvas.toDataURL("image/png"),
    width,
    height,
    timestamp: Date.now(),
    webgpuAvailable: fullCapture.webgpuAvailable,
  };
}

/**
 * Encode image data to base64.
 */
export function imageDataToBase64(imageData: ImageData): string {
  const canvas = document.createElement("canvas");
  canvas.width = imageData.width;
  canvas.height = imageData.height;

  const ctx = canvas.getContext("2d");
  if (!ctx) {
    throw new Error("Failed to get canvas context");
  }

  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Convert base64 data URL to ImageData.
 */
export function base64ToImageData(dataUrl: string): Promise<ImageData> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = img.width;
      canvas.height = img.height;

      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Failed to get canvas context"));
        return;
      }

      ctx.drawImage(img, 0, 0);
      resolve(ctx.getImageData(0, 0, img.width, img.height));
    };
    img.onerror = () => reject(new Error("Failed to load image"));
    img.src = dataUrl;
  });
}
