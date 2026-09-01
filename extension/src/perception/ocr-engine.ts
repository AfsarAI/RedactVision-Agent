/**
 * RedactVision Agent - OCR Engine
 *
 * Local OCR using Tesseract.js for extracting text from images,
 * screenshots, canvas elements, and other visual content that may
 * not be represented in the DOM.
 *
 * This runs entirely client-side - no data leaves the browser.
 */

import { SensitiveEntityType, BoundingBox } from "./sensitive-data-map";

export interface OCRResult {
  /** Extracted text */
  text: string;
  /** Confidence score (0-1) */
  confidence: number;
  /** Bounding boxes for each word/line */
  regions: OCRRegion[];
  /** Processing time in ms */
  processingTimeMs: number;
  /** True detection status — tells callers whether OCR actually ran */
  status: "success" | "unavailable" | "failed" | "skipped";
  /** Source of the detection (tesseract or fallback) */
  source: "tesseract" | "none";
  /** Human-readable message about the detector state */
  message?: string;
}

export interface OCRRegion {
  /** The text that was recognized */
  text: string;
  /** Bounding box in image coordinates */
  boundingBox: BoundingBox;
  /** Confidence for this specific region */
  confidence: number;
  /** Level (word, line, paragraph, etc.) */
  level: "word" | "line" | "paragraph" | "block" | "page";
}

// Tesseract.js types (simplified)
interface TessCallback {
  (result: { data: TessResult }): void;
}

interface TessResult {
  confidence: number;
  lines?: Array<{
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;
  words?: Array<{
    text: string;
    confidence: number;
    bbox: { x0: number; y0: number; x1: number; y1: number };
  }>;
}

/**
 * OCR Engine using Tesseract.js
 */
export class OCREngine {
  private worker: unknown | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private initError: string | null = null;

  /**
   * Initialize the Tesseract worker.
   * Lazy initialization - only loads when first needed.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._initialize();
    return this.initPromise;
  }

  /**
   * Returns true only when the Tesseract worker is actually loaded and usable.
   */
  isWorkerAvailable(): boolean {
    return this.isInitialized && this.worker !== null;
  }

  private async _initialize(): Promise<void> {
    try {
      console.log("[OCREngine] Initializing Tesseract.js worker...");

      // Dynamic import for code splitting
      const Tesseract = await import("tesseract.js");

      // Create worker with language model
      // Using 'eng' for English; can extend to other languages
      this.worker = await Tesseract.createWorker("eng", 1, {
        logger: (m: { status: string; progress?: number }) => {
          if (m.status === "recognizing text" && m.progress) {
            console.log(`[OCREngine] Progress: ${(m.progress * 100).toFixed(1)}%`);
          }
        },
      });

      this.isInitialized = true;
      this.initError = null;
      console.log("[OCREngine] Tesseract.js worker initialized");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("[OCREngine] Tesseract.js unavailable - OCR will be skipped:", error);
      this.isInitialized = true;
      this.initError = msg;
      this.worker = null;
    }
  }

  /**
   * Perform OCR on an image.
   * @param imageSource - Can be a URL, base64 data URL, or ImageData
   * @param options - Optional configuration
   */
  async recognize(
    imageSource: string | ImageData,
    options: {
      enhanceContrast?: boolean;
      language?: string;
    } = {}
  ): Promise<OCRResult> {
    const startTime = performance.now();

    await this.initialize();

    if (!this.worker) {
      return {
        text: "",
        confidence: 0,
        regions: [],
        processingTimeMs: performance.now() - startTime,
        status: "unavailable",
        source: "none",
        message: this.initError
          ? `Tesseract.js failed to initialize: ${this.initError}`
          : "Tesseract.js worker not available",
      };
    }

    // Convert ImageData to data URL if needed
    let imageData = imageSource;
    if (imageSource instanceof ImageData) {
      imageData = imageDataToDataUrl(imageSource);
    }

    try {
      // Cast worker to the correct type for Tesseract.js API
      const tesseractWorker = this.worker as {
        recognize: (image: string | File | Blob, options?: object) => Promise<TessResult>;
      };

      const result = await tesseractWorker.recognize(imageData as string);

      const processingTimeMs = performance.now() - startTime;
      const parsedResult = this.parseTesseractResult(result, processingTimeMs);
      parsedResult.status = "success";
      parsedResult.source = "tesseract";
      return parsedResult;
    } catch (error) {
      console.error("[OCREngine] OCR recognition failed:", error);
      return {
        text: "",
        confidence: 0,
        regions: [],
        processingTimeMs: performance.now() - startTime,
        status: "failed",
        source: "none",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Parse Tesseract output into our OCRResult format.
   */
  private parseTesseractResult(result: TessResult, processingTimeMs: number): OCRResult {
    const regions: OCRRegion[] = [];

    // Process words if available (higher precision)
    if (result.words && result.words.length > 0) {
      for (const word of result.words) {
        regions.push({
          text: word.text.trim(),
          boundingBox: {
            x: word.bbox.x0,
            y: word.bbox.y0,
            width: word.bbox.x1 - word.bbox.x0,
            height: word.bbox.y1 - word.bbox.y0,
          },
          confidence: word.confidence / 100,
          level: "word",
        });
      }
    } else if (result.lines && result.lines.length > 0) {
      // Fall back to lines
      for (const line of result.lines) {
        regions.push({
          text: line.text.trim(),
          boundingBox: {
            x: line.bbox.x0,
            y: line.bbox.y0,
            width: line.bbox.x1 - line.bbox.x0,
            height: line.bbox.y1 - line.bbox.y0,
          },
          confidence: line.confidence / 100,
          level: "line",
        });
      }
    }

    // Extract full text
    const fullText = regions.map(r => r.text).join(" ");

    return {
      text: fullText,
      confidence: result.confidence / 100,
      regions,
      processingTimeMs,
      status: "success",
      source: "tesseract",
    };
  }

  /**
   * Terminate the worker to free resources.
   */
  async terminate(): Promise<void> {
    if (this.worker) {
      try {
        const tesseractWorker = this.worker as { terminate?: () => Promise<void> };
        if (typeof tesseractWorker.terminate === "function") {
          await tesseractWorker.terminate();
        }
      } catch (error) {
        console.warn("[OCREngine] Error terminating worker:", error);
      }
      this.worker = null;
      this.isInitialized = false;
      this.initPromise = null;
    }
  }

  /**
   * Get the current initialization state.
   */
  getState(): { initialized: boolean } {
    return { initialized: this.isInitialized };
  }
}

/**
 * Convert ImageData to base64 data URL.
 */
function imageDataToDataUrl(imageData: ImageData): string {
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
 * Singleton instance for the OCR engine.
 */
let ocrEngineInstance: OCREngine | null = null;

export function getOCREngine(): OCREngine {
  if (!ocrEngineInstance) {
    ocrEngineInstance = new OCREngine();
  }
  return ocrEngineInstance;
}

/**
 * Convenience function to run OCR on an image.
 */
export async function runOCR(
  imageSource: string | ImageData,
  options?: { enhanceContrast?: boolean }
): Promise<OCRResult> {
  const engine = getOCREngine();
  return engine.recognize(imageSource, options);
}
