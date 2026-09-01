/**
 * RedactVision Agent - Computer Vision (CV) Engine
 *
 * Real on-device visual detection using Transformers.js pipeline.
 * Detects sensitive visual regions (faces, ID documents, signatures,
 * cards) from screenshot images using lightweight vision/object-detection
 * models running locally in the browser.
 *
 * This stays entirely client-side — no image data or results leave the
 * browser boundary. The local token map remains client-only.
 *
 * Graceful degradation: if the vision model fails to load or runs out
 * of memory, the engine logs a warning and returns empty detections
 * rather than blocking the pipeline.
 */

import { SensitiveEntityType, BoundingBox } from "./sensitive-data-map";

export interface CVDetection {
  type: SensitiveEntityType; // FACE, ID_DOCUMENT, SIGNATURE, CARD, etc.
  confidence: number; // 0-1
  boundingBox: BoundingBox; // screen/pixel coordinates
  label?: string; // optional descriptive label from model
  source: "cv";
}

export interface CVResult {
  detections: CVDetection[];
  confidence: number; // mean of detections
  processingTimeMs: number;
  modelUsed: string;
  status: "success" | "unavailable" | "failed" | "skipped";
  source: "cv" | "none";
  message?: string;
}

// Vision model reference — lightweight object-detection / face-detection
// via Transformers.js. Actual model choice depends on browser/runtime.
// This reference points to a face/ID-capable vision pipeline when loaded.
const DEFAULT_CV_MODEL = "Xenova/mobileface"; // placeholder-referenced vision model
// Note: Transformers.js vision/object-detection pipelines may use other
// model IDs depending on runtime availability (e.g. COCO-SSD, YOLO, BlazeFace).

/**
 * CV Engine using Transformers.js vision pipeline.
 */
export class CVEngine {
  private pipeline: unknown | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private modelId: string;
  private initError: string | null = null;

  constructor(modelId: string = DEFAULT_CV_MODEL) {
    this.modelId = modelId;
  }

  /**
   * Lazy initialization — loads the vision pipeline via dynamic import.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._initialize();
    return this.initPromise;
  }

  /**
   * Returns true only when the vision pipeline is actually loaded and usable.
   */
  isPipelineAvailable(): boolean {
    return this.isInitialized && this.pipeline !== null;
  }

  private async _initialize(): Promise<void> {
    try {
      console.log("[CVEngine] Initializing vision pipeline...");

      // Dynamic import for code splitting — same pattern as NEREngine
      const { pipeline, env } = await import("@huggingface/transformers");

      env.allowLocalModels = false;
      env.useBrowserCache = true;

      // Try image-classification / vision pipeline first
      // Using a lightweight model that is more likely to load in browser
      this.pipeline = await pipeline(
        "object-detection",
        this.modelId,
        {
          device: "webgpu",
          dtype: "fp16",
        }
      );

      this.isInitialized = true;
      this.initError = null;
      console.log("[CVEngine] Vision pipeline initialized");
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.warn("[CVEngine] Vision pipeline unavailable:", msg);
      this.isInitialized = true;
      this.initError = msg;
      this.pipeline = null;
    }
  }

  /**
   * Run vision detection on an image source.
   * Accepts screenshot data URLs (base64 PNG) and image elements.
   */
  async recognize(
    imageSource: string,
    options: {
      minConfidence?: number;
      maxResults?: number;
    } = {}
  ): Promise<CVResult> {
    const startTime = performance.now();
    await this.initialize();

    const minConfidence = options.minConfidence ?? 0.5;
    const maxResults = options.maxResults ?? 50;

    if (!this.pipeline) {
      return {
        detections: [],
        confidence: 0,
        processingTimeMs: performance.now() - startTime,
        modelUsed: this.modelId,
        status: "unavailable",
        source: "none",
        message: this.initError
          ? `Vision pipeline failed: ${this.initError}`
          : "Vision pipeline not available",
      };
    }

    try {
      // Cast to vision pipeline interface
      type VisionRawDetection = {
        label: string;
        score: number;
        box: { xmin: number; ymin: number; xmax: number; ymax: number };
      };
      const visionPipeline = this.pipeline as ((image: string) => Promise<VisionRawDetection[]>);

      const rawResults = await visionPipeline(imageSource);
      const detections: CVDetection[] = [];

      for (const raw of rawResults.slice(0, maxResults)) {
        if (raw.score < minConfidence) continue;

        const type = this.mapVisionLabel(raw.label);
        if (!type) continue; // Skip non-sensitive categories

        detections.push({
          type,
          confidence: raw.score,
          boundingBox: {
            x: Math.round(raw.box.xmin),
            y: Math.round(raw.box.ymin),
            width: Math.round(raw.box.xmax - raw.box.xmin),
            height: Math.round(raw.box.ymax - raw.box.ymin),
          },
          label: raw.label,
          source: "cv",
        });
      }

      const confidence = detections.length > 0
        ? detections.reduce((sum, d) => sum + d.confidence, 0) / detections.length
        : 0;

      return {
        detections,
        confidence,
        processingTimeMs: performance.now() - startTime,
        modelUsed: this.modelId,
        status: "success",
        source: "cv",
      };
    } catch (error) {
      console.error("[CVEngine] Vision recognition failed:", error);
      return {
        detections: [],
        confidence: 0,
        processingTimeMs: performance.now() - startTime,
        modelUsed: this.modelId,
        status: "failed",
        source: "none",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Map vision model output labels to our sensitive entity types.
   */
  private mapVisionLabel(label: string): SensitiveEntityType | null {
    const clean = label.toLowerCase();
    // Face / person detection
    if (clean.includes("face") || clean.includes("person") || clean.includes("head") || clean.includes("person")) {
      return "FACE";
    }
    // Document / ID / card regions
    if (clean.includes("id") || clean.includes("card") || clean.includes("document") || clean.includes("passport") || clean.includes("license")) {
      return "ID_DOCUMENT";
    }
    // Signature
    if (clean.includes("signature") || clean.includes("sign")) {
      return "SIGNATURE";
    }
    // Credit / bank card visual region
    if (clean.includes("credit") || clean.includes("bank") || clean.includes("card")) {
      return "CARD";
    }
    // Generic sensitive visual PII not specifically categorized
    return null;
  }

  async terminate(): Promise<void> {
    this.pipeline = null;
    this.isInitialized = false;
    this.initPromise = null;
    console.log("[CVEngine] Vision pipeline terminated");
  }

  getState(): { initialized: boolean; modelId: string } {
    return { initialized: this.isInitialized, modelId: this.modelId };
  }
}

// Singleton instance
let cvEngineInstance: CVEngine | null = null;

export function getCVEngine(modelId?: string): CVEngine {
  if (!cvEngineInstance) {
    cvEngineInstance = new CVEngine(modelId);
  }
  return cvEngineInstance;
}

export async function runCV(
  imageSource: string,
  options?: { minConfidence?: number; maxResults?: number }
): Promise<CVResult> {
  const engine = getCVEngine();
  return engine.recognize(imageSource, options);
}
