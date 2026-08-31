/**
 * RedactVision Agent - NER Engine
 *
 * Local Named Entity Recognition using Transformers.js.
 * Identifies entities like PERSON, EMAIL, PHONE, ADDRESS, etc.
 * from text obtained via OCR, DOM, or other perception sources.
 *
 * This runs entirely client-side - no data leaves the browser.
 */

import { SensitiveEntityType, BoundingBox } from "./sensitive-data-map";

export interface NERResult {
  /** The input text */
  text: string;
  /** Detected entities */
  entities: NEREntity[];
  /** Overall confidence */
  confidence: number;
  /** Processing time in ms */
  processingTimeMs: number;
}

export interface NEREntity {
  /** Entity text */
  text: string;
  /** Entity type */
  type: SensitiveEntityType;
  /** Confidence score (0-1) */
  confidence: number;
  /** Start position in original text */
  start: number;
  /** End position in original text */
  end: number;
  /** Optional bounding box (if source had spatial info) */
  boundingBox?: BoundingBox;
}

// Mapping from common NER labels to our entity types
const NER_LABEL_MAP: Record<string, SensitiveEntityType> = {
  // Standard labels
  "PERSON": "PERSON",
  "EMAIL": "EMAIL",
  "PHONE": "PHONE",
  "TEL": "PHONE",
  "MOBILE": "PHONE",
  "ADDRESS": "ADDRESS",
  "LOCATION": "LOCATION",
  "CITY": "LOCATION",
  "COUNTRY": "LOCATION",
  "DATE": "DATE_OF_BIRTH",
  "DATE_OF_BIRTH": "DATE_OF_BIRTH",
  "DOB": "DATE_OF_BIRTH",
  "ID": "ID_NUMBER",
  "NRP": "ID_NUMBER",
  "ID_CARD": "ID_DOCUMENT",
  "PASSPORT": "ID_DOCUMENT",
  "DRIVER_LICENSE": "ID_DOCUMENT",
  "BANK_ACCOUNT": "BANK_ACCOUNT",
  "CREDIT_CARD": "CREDIT_CARD",
  "CARD": "CARD",
  "FACE": "FACE",
  "SIGNATURE": "SIGNATURE",
  "API_KEY": "API_KEY",
  "KEY": "API_KEY",
  "TOKEN": "TOKEN",
  "AUTH_TOKEN": "TOKEN",
  "PASSWORD": "PASSWORD",
  "PASS": "PASSWORD",
  "ORG": "PERSON", // Organizations mapped to PERSON for simplicity
  "GPE": "LOCATION", // Geo-Political Entity
};

/**
 * NER Engine using Transformers.js
 */
export class NEREngine {
  private pipeline: unknown | null = null;
  private isInitialized = false;
  private initPromise: Promise<void> | null = null;
  private modelId: string;

  constructor(modelId: string = "Xenova/bert-base-multilingual-cased-ner-hrl") {
    // Using a lightweight multilingual NER model
    // Alternative: dslim/bert-base-NER (English-only, larger)
    this.modelId = modelId;
  }

  /**
   * Initialize the Transformers.js pipeline.
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

  private async _initialize(): Promise<void> {
    try {
      // Dynamic import for code splitting
      const { pipeline, env } = await import("@huggingface/transformers");

      // Configure for browser optimization
      env.allowLocalModels = false;
      env.useBrowserCache = true;

      // Create NER pipeline with token classification
      this.pipeline = await pipeline(
        "token-classification",
        this.modelId,
        {
          device: "webgpu", // Will fall back to wasm if not available
          dtype: "fp16", // Half precision for speed
        }
      );

      this.isInitialized = true;
      console.log("[NEREngine] Transformers.js pipeline initialized");
    } catch {
      // Clean fallback to deterministic regex-based NER without red console error traces
      this.isInitialized = true;
      this.pipeline = null;
    }
  }

  /**
   * Perform NER on text.
   * @param text - Input text to analyze
   * @param options - Optional configuration
   */
  async recognize(
    text: string,
    options: {
      stride?: number; // For long text processing
    } = {}
  ): Promise<NERResult> {
    const startTime = performance.now();

    // If text is too short, skip NER
    if (text.length < 3) {
      return {
        text,
        entities: [],
        confidence: 0,
        processingTimeMs: performance.now() - startTime,
      };
    }

    // Try ML-based NER first
    if (this.pipeline && this.isInitialized) {
      try {
        return await this.runMLNER(text, startTime);
      } catch (error) {
        console.warn("[NEREngine] ML NER failed, falling back to regex:", error);
      }
    }

    // Fallback to regex-based NER
    return this.runRegexNER(text, startTime);
  }

  /**
   * Run ML-based NER using Transformers.js.
   */
  private async runMLNER(text: string, startTime: number): Promise<NERResult> {
    if (!this.pipeline) {
      throw new Error("Pipeline not initialized");
    }

    try {
      // Cast to the correct type
      const nerPipeline = this.pipeline as (
        text: string,
        options?: { grouped_entities?: boolean }
      ) => Promise<Array<{
        entity: string;
        score: number;
        word: string;
        start: number;
        end: number;
        index?: number;
      }>>;

      const rawEntities = await nerPipeline(text, { grouped_entities: true });

      const entities: NEREntity[] = [];

      for (const raw of rawEntities) {
        const type = this.mapNERLabel(raw.entity);
        if (type) {
          entities.push({
            text: raw.word,
            type,
            confidence: raw.score,
            start: raw.start,
            end: raw.end,
          });
        }
      }

      const confidence = entities.length > 0
        ? entities.reduce((sum, e) => sum + e.confidence, 0) / entities.length
        : 0;

      return {
        text,
        entities,
        confidence,
        processingTimeMs: performance.now() - startTime,
      };
    } catch (error) {
      console.error("[NEREngine] ML NER error:", error);
      throw error;
    }
  }

  /**
   * Run regex-based NER as fallback.
   */
  private runRegexNER(text: string, startTime: number): NERResult {
    const entities: NEREntity[] = [];

    // Email detection
    const emailRegex = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi;
    for (const match of text.matchAll(emailRegex)) {
      if (match.index !== undefined) {
        entities.push({
          text: match[0],
          type: "EMAIL",
          confidence: 0.95,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    // Phone detection (various formats)
    const phonePatterns = [
      /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g, // Indian phone
      /\b\d{3}[-.\s]?\d{3}[-.\s]?\d{4}\b/g, // US phone
      /\b\d{10,12}\b/g, // Generic long number
    ];

    for (const pattern of phonePatterns) {
      for (const match of text.matchAll(pattern)) {
        if (match.index !== undefined) {
          entities.push({
            text: match[0],
            type: "PHONE",
            confidence: 0.9,
            start: match.index,
            end: match.index + match[0].length,
          });
        }
      }
    }

    // Aadhaar-like patterns
    const aadhaarRegex = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;
    for (const match of text.matchAll(aadhaarRegex)) {
      if (match.index !== undefined) {
        entities.push({
          text: match[0],
          type: "AADHAAR",
          confidence: 0.88,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    // Credit card patterns
    const cardRegex = /\b(?:\d[ -]*?){13,19}\b/g;
    for (const match of text.matchAll(cardRegex)) {
      if (match.index !== undefined) {
        const digits = match[0].replace(/\D/g, "");
        if (digits.length >= 13 && digits.length <= 19) {
          entities.push({
            text: match[0],
            type: "CARD",
            confidence: 0.85,
            start: match.index,
            end: match.index + match[0].length,
          });
        }
      }
    }

    // Name patterns (capitalized words near context)
    const namePatterns = [
      /(?:\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.)\s+)?([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})\b/g,
      /(?:Name|Contact|Patient|Customer|Client|User)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/gi,
    ];

    for (const pattern of namePatterns) {
      for (const match of text.matchAll(pattern)) {
        if (match.index !== undefined && match[1]) {
          const name = match[1].trim();
          if (name.length > 2 && name.length < 50) {
            entities.push({
              text: name,
              type: "PERSON",
              confidence: 0.75,
              start: match.index + match[0].indexOf(name),
              end: match.index + match[0].indexOf(name) + name.length,
            });
          }
        }
      }
    }

    // Address patterns
    const addressRegex = /\b\d+\s+[A-Za-z\s]+(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Road),?\s*[A-Za-z\s]+,?\s*[A-Z]{2}\s*\d{5}\b/gi;
    for (const match of text.matchAll(addressRegex)) {
      if (match.index !== undefined) {
        entities.push({
          text: match[0],
          type: "ADDRESS",
          confidence: 0.8,
          start: match.index,
          end: match.index + match[0].length,
        });
      }
    }

    // API Key / Token patterns
    const keyPatterns = [
      /(?:\b(?:api[_-]?key|apikey|secret[_-]?key|auth[_-]?token|access[_-]?token)[:\s=]+)([A-Za-z0-9_\-]{20,})/gi,
      /\b(?:sk|pk|rk)_[A-Za-z0-9]{20,}\b/g,
    ];

    for (const pattern of keyPatterns) {
      for (const match of text.matchAll(pattern)) {
        if (match.index !== undefined) {
          entities.push({
            text: match[1] || match[0],
            type: "API_KEY",
            confidence: 0.9,
            start: match.index,
            end: match.index + (match[1]?.length || match[0].length),
          });
        }
      }
    }

    // Deduplicate overlapping entities
    const deduplicated = deduplicateEntities(entities);

    const confidence = deduplicated.length > 0
      ? deduplicated.reduce((sum, e) => sum + e.confidence, 0) / deduplicated.length
      : 0;

    return {
      text,
      entities: deduplicated,
      confidence,
      processingTimeMs: performance.now() - startTime,
    };
  }

  /**
   * Map NER label from model to our entity type.
   */
  private mapNERLabel(label: string): SensitiveEntityType | null {
    // Clean up the label (remove B-, I- prefixes for BIO tagging)
    const cleanLabel = label.replace(/^[BI]-/, "").toUpperCase();
    return NER_LABEL_MAP[cleanLabel] || null;
  }

  /**
   * Terminate the pipeline to free resources.
   */
  async terminate(): Promise<void> {
    this.pipeline = null;
    this.isInitialized = false;
    this.initPromise = null;
  }

  /**
   * Get the current initialization state.
   */
  getState(): { initialized: boolean; modelId: string } {
    return { initialized: this.isInitialized, modelId: this.modelId };
  }
}

/**
 * Deduplicate overlapping entities, keeping higher confidence ones.
 */
function deduplicateEntities(entities: NEREntity[]): NEREntity[] {
  const sorted = [...entities].sort((a, b) => {
    // First by start position
    if (a.start !== b.start) return a.start - b.start;
    // Then by confidence (higher first)
    return b.confidence - a.confidence;
  });

  const result: NEREntity[] = [];
  let lastEnd = -1;

  for (const entity of sorted) {
    if (entity.start >= lastEnd) {
      result.push(entity);
      lastEnd = entity.end;
    }
  }

  return result;
}

/**
 * Singleton instance for the NER engine.
 */
let nerEngineInstance: NEREngine | null = null;

export function getNEREngine(modelId?: string): NEREngine {
  if (!nerEngineInstance) {
    nerEngineInstance = new NEREngine(modelId);
  }
  return nerEngineInstance;
}

/**
 * Convenience function to run NER on text.
 */
export async function runNER(
  text: string,
  options?: { stride?: number }
): Promise<NERResult> {
  const engine = getNEREngine();
  return engine.recognize(text, options);
}
