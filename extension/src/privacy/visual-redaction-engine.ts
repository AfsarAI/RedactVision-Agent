/**
 * RedactVision Agent - Visual Redaction Engine
 *
 * Redacts sensitive visual regions from screenshots before sending to server.
 * Uses OCR-derived bounding boxes and other detector outputs to mask PII visually.
 *
 * Stays entirely local — redacted images are for local→server context only,
 * and the original sensitive visual data never leaves the browser.
 */

import { SensitiveDataMap, SensitiveRegion, BoundingBox } from "../perception/sensitive-data-map";

export interface RedactionOptions {
  /** Method to redact: "blur", "mask", "pixelate" */
  method?: "blur" | "mask" | "pixelate";
  /** Blur radius for blur method */
  blurRadius?: number;
  /** Color for mask method (hex) */
  maskColor?: string;
  /** Pixelate block size */
  pixelateBlockSize?: number;
  /** Padding around the bounding box (px) */
  padding?: number;
}

export interface RedactionResult {
  /** Base64 data URL of redacted image */
  dataUrl: string;
  /** Original image dimensions */
  width: number;
  height: number;
  /** Number of regions redacted */
  redactedRegions: number;
  /** Processing time (ms) */
  processingTimeMs: number;
  /** Which redaction method was used */
  method: string;
}

/**
 * Redact sensitive regions from a screenshot.
 * Uses the sensitive data map to identify and redact visual PII.
 */
export async function redactScreenshot(
  screenshotDataUrl: string,
  sensitiveDataMap: SensitiveDataMap,
  options: RedactionOptions = {}
): Promise<RedactionResult> {
  const startTime = performance.now();

  const method = options.method || "blur";
  const blurRadius = options.blurRadius || 10;
  const maskColor = options.maskColor || "#000000";
  const pixelateBlockSize = options.pixelateBlockSize || 8;
  const padding = options.padding || 5;

  return new Promise((resolve, reject) => {
    try {
      // Load the screenshot image
      const img = new Image();
      img.crossOrigin = "anonymous";

      img.onload = () => {
        try {
          // Create canvas
          const canvas = document.createElement("canvas");
          canvas.width = img.width;
          canvas.height = img.height;

          const ctx = canvas.getContext("2d");
          if (!ctx) {
            throw new Error("Failed to get canvas context");
          }

          // Draw original image
          ctx.drawImage(img, 0, 0);

          // Collect all regions with bounding boxes
          const regionsToRedact = sensitiveDataMap.regions.filter((r) => r.boundingBox);

          console.log(
            `[VisualRedactionEngine] Redacting ${regionsToRedact.length} regions with bounding boxes`
          );

          // Redact each region
          for (const region of regionsToRedact) {
            if (!region.boundingBox) continue;

            const bbox = region.boundingBox;

            // Apply padding
            const x = Math.max(0, bbox.x - padding);
            const y = Math.max(0, bbox.y - padding);
            const w = Math.min(canvas.width - x, bbox.width + 2 * padding);
            const h = Math.min(canvas.height - y, bbox.height + 2 * padding);

            if (w <= 0 || h <= 0) continue;

            switch (method) {
              case "blur":
                redactRegionBlur(ctx, x, y, w, h, blurRadius);
                break;
              case "mask":
                redactRegionMask(ctx, x, y, w, h, maskColor);
                break;
              case "pixelate":
                redactRegionPixelate(ctx, canvas, x, y, w, h, pixelateBlockSize);
                break;
            }
          }

          // Convert to data URL
          const dataUrl = canvas.toDataURL("image/png");
          const processingTimeMs = performance.now() - startTime;

          resolve({
            dataUrl,
            width: canvas.width,
            height: canvas.height,
            redactedRegions: regionsToRedact.length,
            processingTimeMs,
            method,
          });
        } catch (error) {
          reject(error);
        }
      };

      img.onerror = () => {
        reject(new Error("Failed to load screenshot image"));
      };

      img.src = screenshotDataUrl;
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Redact by applying Gaussian blur.
 */
function redactRegionBlur(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number
): void {
  // Get the image data for this region
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  // Simple box blur approximation
  const blur = (arr: Uint8ClampedArray, stride: number, radius: number) => {
    const rr = radius + radius + 1;
    for (let i = 0; i < stride; i++) {
      let asum = 0;
      let sum = 0;
      let count = 0;

      for (let j = Math.max(0, i - radius); j < Math.min(stride, i + radius + 1); j++) {
        sum += arr[j];
        count++;
      }

      arr[i] = Math.round(sum / count);
    }
  };

  // Apply blur to each channel
  for (let channel = 0; channel < 4; channel++) {
    for (let row = 0; row < h; row++) {
      const offset = row * w * 4 + channel;
      const arr = new Uint8ClampedArray(w);

      for (let col = 0; col < w; col++) {
        arr[col] = data[offset + col * 4];
      }

      blur(arr, w, radius);

      for (let col = 0; col < w; col++) {
        data[offset + col * 4] = arr[col];
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

/**
 * Redact by filling with a solid color.
 */
function redactRegionMask(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string
): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);

  // Add a redaction indicator (optional)
  ctx.strokeStyle = "rgba(255, 0, 0, 0.5)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, w, h);
}

/**
 * Redact by pixelating the region.
 */
function redactRegionPixelate(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  x: number,
  y: number,
  w: number,
  h: number,
  blockSize: number
): void {
  const imageData = ctx.getImageData(x, y, w, h);
  const data = imageData.data;

  // Average each block and fill it with the average color
  for (let by = 0; by < h; by += blockSize) {
    for (let bx = 0; bx < w; bx += blockSize) {
      const blockWidth = Math.min(blockSize, w - bx);
      const blockHeight = Math.min(blockSize, h - by);

      let r = 0, g = 0, b = 0, a = 0;
      let count = 0;

      // Calculate average color
      for (let py = 0; py < blockHeight; py++) {
        for (let px = 0; px < blockWidth; px++) {
          const idx = ((by + py) * w + (bx + px)) * 4;
          r += data[idx];
          g += data[idx + 1];
          b += data[idx + 2];
          a += data[idx + 3];
          count++;
        }
      }

      r = Math.round(r / count);
      g = Math.round(g / count);
      b = Math.round(b / count);
      a = Math.round(a / count);

      // Fill the block
      for (let py = 0; py < blockHeight; py++) {
        for (let px = 0; px < blockWidth; px++) {
          const idx = ((by + py) * w + (bx + px)) * 4;
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = a;
        }
      }
    }
  }

  ctx.putImageData(imageData, x, y);
}

/**
 * Create a sanitized visual summary without sending raw redacted image.
 * Instead, sends bounding boxes and region descriptions.
 */
export interface SanitizedVisualSummary {
  /** Image dimensions */
  width: number;
  height: number;
  /** List of redacted regions (no sensitive values) */
  redactedRegions: Array<{
    /** Type of sensitive data */
    type: string;
    /** Bounding box in image coordinates */
    boundingBox: BoundingBox;
    /** Confidence of detection */
    confidence: number;
  }>;
  /** Whether screenshot is available locally but not sent */
  screenshotRedactedLocally: boolean;
}

/**
 * Generate a safe visual summary for the server.
 * Does NOT send the actual image, just metadata about what was redacted.
 */
export function generateSanitizedVisualSummary(
  screenshotResult: { width: number; height: number },
  sensitiveDataMap: SensitiveDataMap
): SanitizedVisualSummary {
  const redactedRegions = sensitiveDataMap.regions
    .filter((r) => r.boundingBox)
    .map((r) => ({
      type: r.type,
      boundingBox: r.boundingBox!,
      confidence: r.confidence,
    }));

  return {
    width: screenshotResult.width,
    height: screenshotResult.height,
    redactedRegions,
    screenshotRedactedLocally: redactedRegions.length > 0,
  };
}
