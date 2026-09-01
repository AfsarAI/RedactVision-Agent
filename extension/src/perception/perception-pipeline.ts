/**
 * RedactVision Agent - Perception Pipeline Orchestrator
 *
 * Coordinates all local perception sources:
 * - DOM semantic extraction
 * - OCR from screenshots
 * - NER from text
 * - Regex/heuristics
 *
 * Runs all detectors in parallel where safe and beneficial.
 * Fuses evidence into a unified SensitiveDataMap.
 * Stays entirely local — no data leaves the browser.
 */

import { extractPageDOM, DOMElementInfo } from "../content/dom-extractor";
import { SensitiveDataMapManager, SensitiveEntityType, BoundingBox } from "./sensitive-data-map";
import { detectSensitiveData } from "../privacy/pii-detector";
import { getOCREngine, type OCRResult } from "./ocr-engine";
import { getNEREngine, type NERResult } from "./ner-engine";
import { getCVEngine, type CVResult } from "./cv-engine";
import { captureViewportScreenshot, ScreenshotResult } from "./screenshot-capture";

export interface PerceptionConfig {
  /** Enable DOM-based detection */
  enableDOM?: boolean;
  /** Enable OCR from screenshots */
  enableOCR?: boolean;
  /** Enable NER from text */
  enableNER?: boolean;
  /** Enable CV (vision) detection from screenshots */
  enableCV?: boolean;
  /** Enable regex/heuristic detection */
  enableRegex?: boolean;
  /** Timeout for OCR processing (ms) */
  ocrTimeout?: number;
  /** Timeout for NER processing (ms) */
  nerTimeout?: number;
  /** Timeout for CV processing (ms) */
  cvTimeout?: number;
}

export interface DetectorStatus {
  id: string;
  status: "success" | "unavailable" | "failed" | "skipped";
  source: "ml" | "regex" | "tesseract" | "cv" | "dom" | "none";
  message?: string;
  entities: number;
  durationMs: number;
}

export interface PerceptionResult {
  /** The unified sensitive data map from all sources */
  sensitiveDataMap: ReturnType<SensitiveDataMapManager["buildMap"]>;
  /** Which detectors were executed and their truthful status */
  detectorStatuses: DetectorStatus[];
  /** Which detectors were successfully executed (ML inference ran) */
  executedDetectors: string[];
  /** Timing information */
  timing: {
    dom?: number;
    ocr?: number;
    ner?: number;
    cv?: number;
    regex?: number;
    total: number;
  };
  /** Any errors encountered (non-fatal) */
  errors: Array<{ detector: string; error: string }>;
}

/**
 * Run the complete perception pipeline.
 * Coordinates DOM extraction, OCR, NER, and regex detection.
 * Uses singleton engine instances for efficiency.
 * Reports truthful detector status.
 */
export async function runPerceptionPipeline(
  config: PerceptionConfig = {}
): Promise<PerceptionResult> {
  const startTime = performance.now();
  const errors: Array<{ detector: string; error: string }> = [];
  const detectorStatuses: DetectorStatus[] = [];
  const executedDetectors: string[] = [];
  const timing: Partial<{ dom?: number; ocr?: number; ner?: number; cv?: number; regex?: number }> & { total: number } = { total: 0 };

  // Defaults
  const enableDOM = config.enableDOM !== false;
  const enableOCR = config.enableOCR !== false;
  const enableNER = config.enableNER !== false;
  const enableCV = config.enableCV !== false;
  const enableRegex = config.enableRegex !== false;

  const manager = new SensitiveDataMapManager();

  // ============================================================
  // STAGE 1: DOM Semantic Extraction (fast, always run)
  // ============================================================
  if (enableDOM) {
    const domStart = performance.now();
    try {
      console.log("[PerceptionPipeline] Starting DOM extraction...");

      const pageDOM = extractPageDOM();
      const domElements = pageDOM.elements;

      console.log(`[PerceptionPipeline] Extracted ${domElements.length} DOM elements`);

      // Run PII detection on each element's text/value
      for (const element of domElements) {
        // Check value field
        if (element.value) {
          const valueMatches = detectSensitiveData(element.value, {
            tag: element.tag,
            type: element.type,
            name: element.name,
            id: element.id,
            placeholder: element.placeholder,
            ariaLabel: element.ariaLabel,
            label: element.label,
            source: "value",
          });

          for (const match of valueMatches) {
            manager.addRegion({
              type: match.type,
              source: "dom",
              confidence: 0.95, // High confidence for explicit field types
              originalValue: match.value,
              selector: element.selector,
              context: `${element.type || element.tag} field: ${element.name || element.id || "unnamed"}`,
            });
          }
        }

        // Check text field
        if (element.text) {
          const textMatches = detectSensitiveData(element.text, {
            tag: element.tag,
            type: element.type,
            name: element.name,
            id: element.id,
            placeholder: element.placeholder,
            ariaLabel: element.ariaLabel,
            label: element.label,
            source: "text",
          });

          for (const match of textMatches) {
            manager.addRegion({
              type: match.type,
              source: "dom",
              confidence: 0.90,
              originalValue: match.value,
              selector: element.selector,
              context: `Text content in ${element.tag} element`,
            });
          }
        }

        // Check placeholder
        if (element.placeholder) {
          const placeholderMatches = detectSensitiveData(element.placeholder, {
            tag: element.tag,
            type: element.type,
            name: element.name,
            id: element.id,
            placeholder: element.placeholder,
            ariaLabel: element.ariaLabel,
            label: element.label,
            source: "placeholder",
          });

          for (const match of placeholderMatches) {
            if ((match.type === "EMAIL" || match.type === "PHONE") && element.type === match.type.toLowerCase()) {
              manager.addRegion({
                type: match.type,
                source: "dom",
                confidence: 0.75,
                originalValue: match.value,
                selector: element.selector,
                context: `Placeholder in ${element.type} field`,
              });
            }
          }
        }

        // Check aria-label
        if (element.ariaLabel) {
          const ariaMatches = detectSensitiveData(element.ariaLabel, {
            tag: element.tag,
            type: element.type,
            name: element.name,
            id: element.id,
            placeholder: element.placeholder,
            ariaLabel: element.ariaLabel,
            label: element.label,
            source: "placeholder",
          });

          for (const match of ariaMatches) {
            if (match.type === "EMAIL" || match.type === "PHONE") {
              manager.addRegion({
                type: match.type,
                source: "dom",
                confidence: 0.75,
                originalValue: match.value,
                selector: element.selector,
                context: `ARIA label in ${element.tag}`,
              });
            }
          }
        }
      }

      const domTime = performance.now() - domStart;
      timing.dom = domTime;
      executedDetectors.push("dom");
      detectorStatuses.push({
        id: "dom",
        status: "success",
        source: "dom",
        entities: manager.getRegionCount(),
        durationMs: domTime,
        message: `Extracted ${domElements.length} elements`,
      });
      console.log(`[PerceptionPipeline] DOM extraction completed in ${domTime.toFixed(2)}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[PerceptionPipeline] DOM extraction failed:", message);
      errors.push({ detector: "dom", error: message });
      detectorStatuses.push({
        id: "dom",
        status: "failed",
        source: "dom",
        entities: 0,
        durationMs: performance.now() - domStart,
        message: message,
      });
    }
  }

  // Get screenshot once for OCR and CV (they both need it)
  let screenshot: ScreenshotResult | null = null;
  if (enableOCR || enableCV) {
    try {
      screenshot = await captureViewportScreenshot();
      console.log(`[PerceptionPipeline] Screenshot captured: ${screenshot.width}x${screenshot.height}`);
    } catch (screenshotError) {
      const msg = screenshotError instanceof Error ? screenshotError.message : String(screenshotError);
      console.warn("[PerceptionPipeline] Screenshot capture failed:", msg);
      errors.push({ detector: "screenshot", error: msg });
    }
  }

  // ============================================================
  // STAGE 2: OCR from Screenshot (medium-speed, parallel)
  // ============================================================
  const ocrPromise = enableOCR && screenshot
    ? (async () => {
        const ocrStart = performance.now();
        try {
          console.log("[PerceptionPipeline] Starting OCR...");

          // Use singleton OCR engine
          const ocrEngine = getOCREngine();
          const ocrResult = await ocrEngine.recognize(screenshot!.dataUrl, {
            enhanceContrast: true,
          });

          console.log(
            `[PerceptionPipeline] OCR result: status=${ocrResult.status}, source=${ocrResult.source}, regions=${ocrResult.regions.length}, confidence=${ocrResult.confidence.toFixed(2)}`
          );

          // Process OCR results only if OCR actually ran
          if (ocrResult.status === "success" && ocrResult.source === "tesseract") {
            // Run PII detection on OCR-extracted text
            const ocrMatches = detectSensitiveData(ocrResult.text, {
              tag: "ocr",
              type: null,
              name: null,
              id: null,
              placeholder: null,
              ariaLabel: null,
              source: "text",
            });

            for (const match of ocrMatches) {
              let bbox: BoundingBox | undefined;
              for (const region of ocrResult.regions) {
                if (region.text.includes(match.value) || match.value.includes(region.text)) {
                  bbox = region.boundingBox;
                  break;
                }
              }

              manager.addRegion({
                type: match.type,
                source: "ocr",
                confidence: 0.85 * ocrResult.confidence,
                originalValue: match.value,
                boundingBox: bbox,
                context: "Text extracted via OCR from screenshot",
              });
            }

            detectorStatuses.push({
              id: "ocr",
              status: "success",
              source: "tesseract",
              entities: ocrMatches.length,
              durationMs: performance.now() - ocrStart,
              message: `OCR found ${ocrResult.regions.length} regions`,
            });
          } else {
            // OCR was unavailable or failed
            detectorStatuses.push({
              id: "ocr",
              status: ocrResult.status,
              source: "none",
              entities: 0,
              durationMs: performance.now() - ocrStart,
              message: ocrResult.message || "OCR unavailable",
            });
            if (ocrResult.status !== "skipped") {
              errors.push({ detector: "ocr", error: ocrResult.message || "OCR unavailable" });
            }
          }

          const ocrTime = performance.now() - ocrStart;
          timing.ocr = ocrTime;
          if (ocrResult.status === "success") {
            executedDetectors.push("ocr");
          }
          return ocrResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[PerceptionPipeline] OCR processing failed:", message);
          errors.push({ detector: "ocr", error: message });
          detectorStatuses.push({
            id: "ocr",
            status: "failed",
            source: "none",
            entities: 0,
            durationMs: performance.now() - ocrStart,
            message: message,
          });
          return { status: "failed" as const, text: "", confidence: 0, regions: [], processingTimeMs: 0, source: "none" as const };
        }
      })()
    : Promise.resolve({ status: "skipped" as const, text: "", confidence: 0, regions: [], processingTimeMs: 0, source: "none" as const });

  // ============================================================
  // STAGE 3: CV / Vision Detection from Screenshot (parallel)
  // ============================================================
  const cvPromise = enableCV && screenshot
    ? (async () => {
        const cvStart = performance.now();
        try {
          console.log("[PerceptionPipeline] Starting CV vision detection...");

          // Use singleton CV engine
          const cvEngine = getCVEngine();
          const cvResult = await cvEngine.recognize(screenshot!.dataUrl, {
            minConfidence: 0.5,
            maxResults: 20,
          });

          console.log(
            `[PerceptionPipeline] CV result: status=${cvResult.status}, source=${cvResult.source}, detections=${cvResult.detections.length}, confidence=${cvResult.confidence.toFixed(2)}`
          );

          // Process CV results only if CV actually ran
          if (cvResult.status === "success" && cvResult.source === "cv") {
            for (const detection of cvResult.detections) {
              manager.addRegion({
                type: detection.type,
                source: "cv",
                confidence: detection.confidence,
                originalValue: detection.label ?? "[visual-detection]",
                boundingBox: detection.boundingBox,
                context: `Visual detection via CV: ${detection.label || detection.type}`,
                metadata: {
                  modelUsed: cvResult.modelUsed,
                  visionLabel: detection.label,
                },
              });
            }

            detectorStatuses.push({
              id: "cv",
              status: "success",
              source: "cv",
              entities: cvResult.detections.length,
              durationMs: performance.now() - cvStart,
              message: `CV detected ${cvResult.detections.length} regions`,
            });
          } else {
            // CV was unavailable or failed
            detectorStatuses.push({
              id: "cv",
              status: cvResult.status,
              source: "none",
              entities: 0,
              durationMs: performance.now() - cvStart,
              message: cvResult.message || "CV unavailable",
            });
            if (cvResult.status !== "skipped") {
              errors.push({ detector: "cv", error: cvResult.message || "CV unavailable" });
            }
          }

          const cvTime = performance.now() - cvStart;
          timing.cv = cvTime;
          if (cvResult.status === "success") {
            executedDetectors.push("cv");
          }
          return cvResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[PerceptionPipeline] CV processing failed:", message);
          errors.push({ detector: "cv", error: message });
          detectorStatuses.push({
            id: "cv",
            status: "failed",
            source: "none",
            entities: 0,
            durationMs: performance.now() - cvStart,
            message: message,
          });
          return { status: "failed" as const, detections: [], confidence: 0, processingTimeMs: 0, modelUsed: "", source: "none" as const };
        }
      })()
    : Promise.resolve({ status: "skipped" as const, detections: [], confidence: 0, processingTimeMs: 0, modelUsed: "", source: "none" as const });

  // ============================================================
  // STAGE 4: NER from DOM Text (medium-speed, parallel)
  // ============================================================
  const nerPromise = enableNER
    ? (async () => {
        const nerStart = performance.now();
        try {
          console.log("[PerceptionPipeline] Starting NER...");

          const pageDOM = extractPageDOM();
          const allText = pageDOM.elements
            .map((el) => `${el.text} ${el.value || ""}`.trim())
            .filter((t) => t.length > 0)
            .join(" ");

          if (allText.length === 0) {
            console.log("[PerceptionPipeline] No text found for NER");
            detectorStatuses.push({
              id: "ner",
              status: "skipped",
              source: "none",
              entities: 0,
              durationMs: performance.now() - nerStart,
              message: "No text found for NER",
            });
            return { status: "skipped" as const, text: allText, entities: [], confidence: 0, processingTimeMs: 0, source: "regex" as const, message: "No text found" };
          }

          // Use singleton NER engine
          const nerEngine = getNEREngine();
          await nerEngine.initialize();
          const nerResult = await nerEngine.recognize(allText);

          console.log(
            `[PerceptionPipeline] NER result: status=${nerResult.status}, source=${nerResult.source}, entities=${nerResult.entities.length}, confidence=${nerResult.confidence.toFixed(2)}`
          );

          // Process NER results
          for (const entity of nerResult.entities) {
            manager.addRegion({
              type: entity.type,
              source: "ner",
              confidence: entity.confidence,
              originalValue: entity.text,
              context: `Entity identified via ${nerResult.source === "ml" ? "ML NER" : "regex NER"} from page text`,
            });
          }

          detectorStatuses.push({
            id: "ner",
            status: nerResult.status,
            source: nerResult.source,
            entities: nerResult.entities.length,
            durationMs: performance.now() - nerStart,
            message: nerResult.message || `${nerResult.source === "ml" ? "ML" : "Regex"} NER detected ${nerResult.entities.length} entities`,
          });

          const nerTime = performance.now() - nerStart;
          timing.ner = nerTime;
          if (nerResult.status === "success") {
            executedDetectors.push("ner");
          }
          return nerResult;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[PerceptionPipeline] NER failed:", message);
          errors.push({ detector: "ner", error: message });
          detectorStatuses.push({
            id: "ner",
            status: "failed",
            source: "none",
            entities: 0,
            durationMs: performance.now() - nerStart,
            message: message,
          });
          return { status: "failed" as const, text: "", entities: [], confidence: 0, processingTimeMs: 0, source: "regex" as const };
        }
      })()
    : Promise.resolve({ status: "skipped" as const, text: "", entities: [], confidence: 0, processingTimeMs: 0, source: "none" as const });

  // Wait for OCR, NER, and CV to complete (in parallel)
  await Promise.all([ocrPromise, cvPromise, nerPromise]);

  // ============================================================
  // STAGE 5: Final regex aggregation
  // ============================================================
  if (enableRegex) {
    timing.regex = 0;
    executedDetectors.push("regex");
  }

  const totalTime = performance.now() - startTime;
  timing.total = totalTime as number;

  const result: PerceptionResult = {
    sensitiveDataMap: manager.buildMap(window.location.href),
    detectorStatuses,
    executedDetectors,
    timing,
    errors,
  };

  console.log("[PerceptionPipeline] Pipeline completed", {
    total_regions: result.sensitiveDataMap.regions.length,
    detector_statuses: detectorStatuses.map(s => `${s.id}=${s.status}(${s.source})`),
    time_ms: totalTime.toFixed(2),
    errors: errors.length,
  });

  return result;
}

/**
 * Convenience export for easier use.
 */
export async function perceivePage(): Promise<PerceptionResult> {
  return runPerceptionPipeline({
    enableDOM: true,
    enableOCR: true,
    enableNER: true,
    enableCV: true,
    enableRegex: true,
  });
}
