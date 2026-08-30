/**
 * RedactVision Agent - Perception Module Exports
 */

export { runPerceptionPipeline, perceivePage } from "./perception-pipeline";
export type { PerceptionConfig, PerceptionResult } from "./perception-pipeline";

export { SensitiveDataMapManager } from "./sensitive-data-map";
export type {
  SensitiveEntityType,
  DetectionSource,
  SensitiveRegion,
  BoundingBox,
  SensitiveDataMap,
} from "./sensitive-data-map";

export { OCREngine, getOCREngine, runOCR } from "./ocr-engine";
export type { OCRResult, OCRRegion } from "./ocr-engine";

export { NEREngine, getNEREngine, runNER } from "./ner-engine";
export type { NERResult, NEREntity } from "./ner-engine";

export { CVEngine, getCVEngine, runCV } from "./cv-engine";
export type { CVResult, CVDetection } from "./cv-engine";

export {
  captureViewportScreenshot,
  captureViewportCanvas,
} from "./screenshot-capture";
export type { ScreenshotResult } from "./screenshot-capture";
