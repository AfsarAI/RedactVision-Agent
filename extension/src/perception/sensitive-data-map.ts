/**
 * RedactVision Agent - Sensitive Data Map
 *
 * Unified representation of all detected sensitive information
 * across all perception sources (DOM, OCR, NER, CV).
 *
 * This map is the source of truth for redaction decisions.
 * It stays LOCAL and is NEVER sent to the server.
 */

export type SensitiveEntityType =
  | "EMAIL"
  | "PHONE"
  | "PASSWORD"
  | "CARD"
  | "AADHAAR"
  | "PERSON"
  | "ADDRESS"
  | "LOCATION"
  | "ID_NUMBER"
  | "BANK_ACCOUNT"
  | "DATE_OF_BIRTH"
  | "FACE"
  | "ID_DOCUMENT"
  | "SIGNATURE"
  | "CREDIT_CARD"
  | "API_KEY"
  | "TOKEN"
  | "GENERIC_PII";

export type DetectionSource =
  | "dom"
  | "ocr"
  | "ner"
  | "cv"
  | "regex"
  | "heuristic";

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SensitiveRegion {
  /** Unique identifier for this detection */
  id: string;
  /** Type of sensitive entity */
  type: SensitiveEntityType;
  /** Which detector found this */
  source: DetectionSource;
  /** Confidence score (0-1) */
  confidence: number;
  /** Bounding box in screen coordinates (optional) */
  boundingBox?: BoundingBox;
  /** Original sensitive value */
  originalValue: string;
  /** Semantic token to replace this value */
  token: string;
  /** Associated element selector (if from DOM) */
  selector?: string;
  /** Text context around this detection */
  context?: string;
  /** Timestamp when detected */
  detectedAt: number;
  /** Additional metadata from the detector */
  metadata?: Record<string, unknown>;
}

export interface SensitiveDataMap {
  /** All detected sensitive regions */
  regions: SensitiveRegion[];
  /** Count by entity type */
  countsByType: Record<SensitiveEntityType, number>;
  /** Count by detection source */
  countsBySource: Record<DetectionSource, number>;
  /** Total confidence score (average of all detections) */
  overallConfidence: number;
  /** Timestamp of last update */
  updatedAt: number;
  /** Page URL this map was generated for */
  pageUrl: string;
}

/**
 * Manager for the unified sensitive data map.
 * Combines detections from all perception sources.
 */
export class SensitiveDataMapManager {
  private regions: Map<string, SensitiveRegion> = new Map();
  private tokenMap: Map<string, SensitiveRegion> = new Map();
  private tokenCounters: Record<SensitiveEntityType, number> = {} as Record<SensitiveEntityType, number>;
  private pageUrl: string = "";

  constructor() {
    // Initialize counters for all entity types
    const entityTypes: SensitiveEntityType[] = [
      "EMAIL", "PHONE", "PASSWORD", "CARD", "AADHAAR", "PERSON",
      "ADDRESS", "LOCATION", "ID_NUMBER", "BANK_ACCOUNT", "DATE_OF_BIRTH",
      "FACE", "ID_DOCUMENT", "SIGNATURE", "CREDIT_CARD", "API_KEY", "TOKEN", "GENERIC_PII"
    ];
    for (const type of entityTypes) {
      this.tokenCounters[type] = 0;
    }
  }

  /**
   * Add a sensitive region from any perception source.
   * Deduplicates by comparing original values and types.
   */
  addRegion(region: Omit<SensitiveRegion, "id" | "token" | "detectedAt">): SensitiveRegion {
    // Check for existing region with same value and type
    const existingKey = `${region.type}:${region.originalValue.toLowerCase()}`;

    for (const existing of this.regions.values()) {
      if (
        existing.type === region.type &&
        existing.originalValue.toLowerCase() === region.originalValue.toLowerCase()
      ) {
        // Merge: keep the higher confidence detection
        if (existing.confidence >= region.confidence) {
          return existing;
        }
        // Replace with higher confidence detection
        this.regions.delete(existing.id);
        this.tokenMap.delete(existing.token);
        break;
      }
    }

    // Generate new token
    this.tokenCounters[region.type]++;
    const token = `[${region.type}_${String(this.tokenCounters[region.type]).padStart(2, "0")}]`;

    const fullRegion: SensitiveRegion = {
      ...region,
      id: `sdr_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      token,
      detectedAt: Date.now(),
    };

    this.regions.set(fullRegion.id, fullRegion);
    this.tokenMap.set(token, fullRegion);

    return fullRegion;
  }

  /**
   * Get all regions.
   */
  getRegions(): SensitiveRegion[] {
    return Array.from(this.regions.values());
  }

  /**
   * Get regions by type.
   */
  getRegionsByType(type: SensitiveEntityType): SensitiveRegion[] {
    return this.getRegions().filter(r => r.type === type);
  }

  /**
   * Get regions by source.
   */
  getRegionsBySource(source: DetectionSource): SensitiveRegion[] {
    return this.getRegions().filter(r => r.source === source);
  }

  /**
   * Get a region by its token.
   */
  getRegionByToken(token: string): SensitiveRegion | undefined {
    return this.tokenMap.get(token);
  }

  /**
   * Resolve a token back to its original value.
   */
  resolveToken(token: string): string | null {
    const region = this.tokenMap.get(token);
    return region?.originalValue ?? null;
  }

  /**
   * Get the full token map for local use only.
   */
  getTokenMap(): Array<{ token: string; type: SensitiveEntityType; originalValue: string }> {
    return Array.from(this.tokenMap.values()).map(r => ({
      token: r.token,
      type: r.type,
      originalValue: r.originalValue,
    }));
  }

  /**
   * Build the complete SensitiveDataMap for the current state.
   */
  buildMap(pageUrl: string): SensitiveDataMap {
    const regions = this.getRegions();

    const countsByType: Record<SensitiveEntityType, number> = {} as Record<SensitiveEntityType, number>;
    const countsBySource: Record<DetectionSource, number> = {} as Record<DetectionSource, number>;

    for (const region of regions) {
      countsByType[region.type] = (countsByType[region.type] || 0) + 1;
      countsBySource[region.source] = (countsBySource[region.source] || 0) + 1;
    }

    const overallConfidence = regions.length > 0
      ? regions.reduce((sum, r) => sum + r.confidence, 0) / regions.length
      : 0;

    return {
      regions,
      countsByType,
      countsBySource,
      overallConfidence,
      updatedAt: Date.now(),
      pageUrl,
    };
  }

  /**
   * Clear all detections.
   */
  clear(): void {
    this.regions.clear();
    this.tokenMap.clear();
    for (const type of Object.keys(this.tokenCounters) as SensitiveEntityType[]) {
      this.tokenCounters[type] = 0;
    }
  }

  /**
   * Get summary statistics.
   */
  getSummary(): { total: number; byType: Record<string, number>; bySource: Record<string, number> } {
    const regions = this.getRegions();
    const byType: Record<string, number> = {};
    const bySource: Record<string, number> = {};

    for (const region of regions) {
      byType[region.type] = (byType[region.type] || 0) + 1;
      bySource[region.source] = (bySource[region.source] || 0) + 1;
    }

    return { total: regions.length, byType, bySource };
  }

  /**
   * Get total count of regions in the map.
   */
  getRegionCount(): number {
    return this.getRegions().length;
  }
}
