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
import { OCREngine, OCRResult } from "./ocr-engine";
import { NEREngine, NERResult } from "./ner-engine";
import { CVEngine, CVResult } from "./cv-engine";
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

export interface PerceptionResult {
  /** The unified sensitive data map from all sources */
  sensitiveDataMap: ReturnType<SensitiveDataMapManager["buildMap"]>;
  /** Which detectors were executed */
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
 */
export async function runPerceptionPipeline(
  config: PerceptionConfig = {}
): Promise<PerceptionResult> {
  const startTime = performance.now();
  const errors: Array<{ detector: string; error: string }> = [];
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
    try {
      const domStart = performance.now();
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

          // Placeholder detection has lower confidence because it's usually instructional
          for (const match of placeholderMatches) {
            // Only flag if high-confidence pattern (email, phone with field type hint)
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
            source: "placeholder", // Accessibility labels are like placeholders
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
      console.log(`[PerceptionPipeline] DOM extraction completed in ${domTime.toFixed(2)}ms`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error("[PerceptionPipeline] DOM extraction failed:", message);
      errors.push({ detector: "dom", error: message });
    }
  }

  // ============================================================
  // STAGE 2: OCR from Screenshot (medium-speed, parallel)
  // ============================================================
  const ocrPromise = enableOCR
    ? (async () => {
        try {
          const ocrStart = performance.now();
          console.log("[PerceptionPipeline] Starting OCR...");

          const screenshot = await captureViewportScreenshot();
          console.log(
            `[PerceptionPipeline] Screenshot captured: ${screenshot.width}x${screenshot.height}`
          );

          const ocrEngine = new OCREngine();
          const ocrResult = await ocrEngine.recognize(screenshot.dataUrl, {
            enhanceContrast: true,
          });

          console.log(
            `[PerceptionPipeline] OCR extracted ${ocrResult.regions.length} regions, confidence: ${ocrResult.confidence.toFixed(2)}`
          );

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
            // Find corresponding bounding box from OCR regions
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
              confidence: 0.85 * ocrResult.confidence, // Scale by OCR confidence
              originalValue: match.value,
              boundingBox: bbox,
              context: "Text extracted via OCR from screenshot",
            });
          }

          // Also run NER on OCR text if enabled
          if (enableNER) {
            try {
              const nerEngine = new NEREngine();
              await nerEngine.initialize();
              const nerResult = await nerEngine.recognize(ocrResult.text);

              for (const entity of nerResult.entities) {
                manager.addRegion({
                  type: entity.type,
                  source: "ocr", // Source is OCR, but detector is NER
                  confidence: entity.confidence * 0.9,
                  originalValue: entity.text,
                  context: `Entity identified via NER on OCR text`,
                });
              }
            } catch (nerError) {
              const msg = nerError instanceof Error ? nerError.message : String(nerError);
              console.warn("[PerceptionPipeline] NER on OCR text failed:", msg);
            }
          }

          await ocrEngine.terminate();

          const ocrTime = performance.now() - ocrStart;
          timing.ocr = ocrTime;
          return { success: true, time: ocrTime };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[PerceptionPipeline] OCR unavailable on this page:", message);
          errors.push({ detector: "ocr", error: message });
          return { success: false, time: 0 };
        }
      })()
    : Promise.resolve({ success: false, time: 0 });

  // ============================================================
  // STAGE 3: CV / Vision Detection from Screenshot (parallel)
  // ============================================================
  const cvPromise = enableCV
    ? (async () => {
        try {
          const cvStart = performance.now();
          console.log("[PerceptionPipeline] Starting CV vision detection...");

          const screenshot = await captureViewportScreenshot();
          console.log(
            `[PerceptionPipeline] Screenshot for CV: ${screenshot.width}x${screenshot.height}`
          );

          const cvEngine = new CVEngine();
          const cvResult = await cvEngine.recognize(screenshot.dataUrl, {
            minConfidence: 0.5,
            maxResults: 20,
          });

          console.log(
            `[PerceptionPipeline] CV detected ${cvResult.detections.length} visual regions, confidence: ${cvResult.confidence.toFixed(2)}`
          );

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

          await cvEngine.terminate();

          const cvTime = performance.now() - cvStart;
          timing.cv = cvTime;
          return { success: true, time: cvTime };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.warn("[PerceptionPipeline] CV unavailable on this page:", message);
          errors.push({ detector: "cv", error: message });
          return { success: false, time: 0 };
        }
      })()
    : Promise.resolve({ success: false, time: 0 });

  // ============================================================
  // STAGE 4: NER from DOM Text (medium-speed, parallel)
  // ============================================================
  const nerPromise = enableNER
    ? (async () => {
        try {
          const nerStart = performance.now();
          console.log("[PerceptionPipeline] Starting NER...");

          const pageDOM = extractPageDOM();
          const allText = pageDOM.elements
            .map((el) => `${el.text} ${el.value || ""}`.trim())
            .filter((t) => t.length > 0)
            .join(" ");

          if (allText.length === 0) {
            console.log("[PerceptionPipeline] No text found for NER");
            return { success: true, time: 0 };
          }

          const nerEngine = new NEREngine();
          await nerEngine.initialize();
          const nerResult = await nerEngine.recognize(allText);

          console.log(
            `[PerceptionPipeline] NER identified ${nerResult.entities.length} entities, confidence: ${nerResult.confidence.toFixed(2)}`
          );

          for (const entity of nerResult.entities) {
            manager.addRegion({
              type: entity.type,
              source: "ner",
              confidence: entity.confidence,
              originalValue: entity.text,
              context: "Entity identified via NER from page text",
            });
          }

          const nerTime = performance.now() - nerStart;
          timing.ner = nerTime;
          return { success: true, time: nerTime };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error("[PerceptionPipeline] NER failed:", message);
          errors.push({ detector: "ner", error: message });
          return { success: false, time: 0 };
        }
      })()
    : Promise.resolve({ success: false, time: 0 });

  // Wait for OCR, NER, and CV to complete (in parallel)
  const [ocrResult, nerResult, cvResult] = await Promise.all([ocrPromise, nerPromise, cvPromise]);

  if (ocrResult.success) {
    executedDetectors.push("ocr");
  }
  if (nerResult.success) {
    executedDetectors.push("ner");
  }
  if (cvResult.success) {
    executedDetectors.push("cv");
  }

  // ============================================================
  // STAGE 4: Final regex aggregation (no additional regex — already run by detectors)
  // ============================================================
  if (enableRegex) {
    timing.regex = 0; // Regex is already applied by detectSensitiveData
    executedDetectors.push("regex");
  }

  const totalTime = performance.now() - startTime;
  timing.total = totalTime as number;

  const result: PerceptionResult = {
    sensitiveDataMap: manager.buildMap(window.location.href),
    executedDetectors,
    timing,
    errors,
  };

  console.log("[PerceptionPipeline] Pipeline completed", {
    total_regions: result.sensitiveDataMap.regions.length,
    detectors: executedDetectors,
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
