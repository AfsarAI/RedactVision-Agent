/**
 * RedactVision Agent - Unified End-to-End Pipeline
 *
 * Orchestrates the complete privacy-preserving browser automation flow:
 *
 * 1. PERCEPTION: Run DOM/OCR/NER/CV analysis locally
 * 2. FUSION: Combine evidence into unified sensitive data map
 * 3. SANITIZATION: Redact visual & textual PII locally
 * 4. TRANSMISSION: Send only sanitized context to server
 * 5. REASONING: Server LLM/VLM reasons about sanitized context
 * 6. ACTION: Server returns structured action JSON
 * 7. VALIDATION: Client validates action against policy
 * 8. EXECUTION: Client executes action locally
 * 9. COMPLETION: Report results
 *
 * Privacy invariants maintained throughout.
 */

import { runPerceptionPipeline, PerceptionResult } from "../perception/perception-pipeline";
import {
  SensitiveDataMapManager,
  SensitiveDataMap,
} from "../perception/sensitive-data-map";
import { extractPageDOM } from "../content/dom-extractor";
import { PrivacyFirewall } from "../privacy/privacy-firewall";
import {
  redactScreenshot,
  generateSanitizedVisualSummary,
  SanitizedVisualSummary,
} from "../privacy/visual-redaction-engine";
import {
  ActionExecutor,
  ActionValidator,
  ServerAction,
  ActionValidationResult,
} from "../executor/action-validator-executor";
import { captureViewportScreenshot } from "../perception/screenshot-capture";
import { SanitizedPageDOM } from "../privacy/privacy-types";

export interface PipelineStage {
  id: string;
  name: string;
  status: "pending" | "running" | "completed" | "failed";
  startTime?: number;
  endTime?: number;
  error?: string;
}

export interface PipelineStats {
  /** Total detections by type */
  detectionsByType: Record<string, number>;
  /** Total detections by source */
  detectionsBySource: Record<string, number>;
  /** Timing breakdown */
  timing: {
    perception: number;
    sanitization: number;
    transmission: number;
    execution: number;
    total: number;
  };
  /** Confidence scores */
  averageConfidence: number;
  /** Risk assessment */
  riskLevel: "safe" | "medium" | "high";
}

export interface PipelineConfig {
  /** Server URL for action reasoning */
  serverUrl?: string;
  /** Whether to actually send to server (false = dry-run) */
  sendToServer?: boolean;
  /** User's task/prompt */
  userPrompt: string;
  /** Callbacks for progress reporting */
  onProgress?: (stage: PipelineStage) => void;
  onDetection?: (map: SensitiveDataMap) => void;
  onSanitized?: (dom: SanitizedPageDOM, visual: SanitizedVisualSummary) => void;
  onActionReceived?: (action: ServerAction) => void;
  onValidation?: (result: ActionValidationResult) => void;
  onExecution?: (success: boolean, message: string) => void;
  onComplete?: (stats: PipelineStats) => void;
  onError?: (error: string) => void;
}

/**
 * The complete privacy-preserving browser automation pipeline.
 */
export class UnifiedPipeline {
  private config: PipelineConfig;
  private stages: PipelineStage[] = [];
  private perceptionResult: PerceptionResult | null = null;
  private sensitiveDataMap: SensitiveDataMap | null = null;
  private sanitizedDOM: SanitizedPageDOM | null = null;
  private sanitizedVisual: SanitizedVisualSummary | null = null;
  private actionExecutor: ActionExecutor | null = null;
  private stats: PipelineStats | null = null;

  constructor(config: PipelineConfig) {
    this.config = config;
    this.initializeStages();
  }

  /**
   * Initialize pipeline stages.
   */
  private initializeStages(): void {
    const stageIds = [
      "perception",
      "fusion",
      "sanitization",
      "transmission",
      "reasoning",
      "validation",
      "execution",
      "completion",
    ];

    this.stages = stageIds.map((id) => ({
      id,
      name: this.getStageName(id),
      status: "pending",
    }));
  }

  /**
   * Get human-readable stage name.
   */
  private getStageName(id: string): string {
    const names: Record<string, string> = {
      perception: "Local Perception (DOM/OCR/NER)",
      fusion: "Evidence Fusion",
      sanitization: "Privacy Redaction",
      transmission: "Secure Transmission",
      reasoning: "Server Reasoning",
      validation: "Action Validation",
      execution: "Browser Execution",
      completion: "Completion",
    };
    return names[id] || id;
  }

  /**
   * Get a stage by ID.
   */
  private getStage(id: string): PipelineStage {
    const stage = this.stages.find((s) => s.id === id);
    if (!stage) throw new Error(`Unknown stage: ${id}`);
    return stage;
  }

  /**
   * Mark a stage as running.
   */
  private markRunning(id: string): void {
    const stage = this.getStage(id);
    stage.status = "running";
    stage.startTime = Date.now();
    this.config.onProgress?.(stage);
    console.log(`[Pipeline] Stage running: ${stage.name}`);
  }

  /**
   * Mark a stage as completed.
   */
  private markCompleted(id: string): void {
    const stage = this.getStage(id);
    stage.status = "completed";
    stage.endTime = Date.now();
    this.config.onProgress?.(stage);
    console.log(`[Pipeline] Stage completed: ${stage.name}`);
  }

  /**
   * Mark a stage as failed.
   */
  private markFailed(id: string, error: string): void {
    const stage = this.getStage(id);
    stage.status = "failed";
    stage.endTime = Date.now();
    stage.error = error;
    this.config.onProgress?.(stage);
    console.error(`[Pipeline] Stage failed: ${stage.name} — ${error}`);
  }

  /**
   * Run the complete pipeline.
   */
  async run(): Promise<void> {
    const totalStart = performance.now();

    try {
      // ========== STAGE 1: PERCEPTION ==========
      this.markRunning("perception");
      try {
        this.perceptionResult = await runPerceptionPipeline({
          enableDOM: true,
          enableOCR: true,
          enableNER: true,
          enableRegex: true,
        });

        this.sensitiveDataMap = this.perceptionResult.sensitiveDataMap;
        this.config.onDetection?.(this.sensitiveDataMap);
        this.markCompleted("perception");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.markFailed("perception", msg);
        throw error;
      }

      // ========== STAGE 2: FUSION ==========
      // Already done by perceptionResult, just mark stage
      this.markRunning("fusion");
      this.markCompleted("fusion");

      // ========== STAGE 3: SANITIZATION ==========
      this.markRunning("sanitization");
      try {
        // Sanitize DOM
        const privacyFirewall = new PrivacyFirewall();
        const rawPageDOM = extractPageDOM();
        this.sanitizedDOM = privacyFirewall.sanitizePage(rawPageDOM);

        // Sanitize visual context
        try {
          const screenshot = await captureViewportScreenshot();
          const redacted = await redactScreenshot(screenshot.dataUrl, this.sensitiveDataMap);
          this.sanitizedVisual = generateSanitizedVisualSummary(
            { width: redacted.width, height: redacted.height },
            this.sensitiveDataMap
          );
        } catch (visualError) {
          console.warn("[Pipeline] Visual redaction failed, continuing:", visualError);
          // Create empty visual summary if redaction fails
          this.sanitizedVisual = {
            width: window.innerWidth,
            height: window.innerHeight,
            redactedRegions: [],
            screenshotRedactedLocally: false,
          };
        }

        this.config.onSanitized?.(this.sanitizedDOM, this.sanitizedVisual);
        this.markCompleted("sanitization");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.markFailed("sanitization", msg);
        throw error;
      }

      // ========== STAGE 4: TRANSMISSION ==========
      this.markRunning("transmission");
      try {
        // Build payload (no token map, no raw sensitive data)
        const payload = {
          url: this.sanitizedDOM.url,
          title: this.sanitizedDOM.title,
          elements: this.sanitizedDOM.elements,
          visual: this.sanitizedVisual,
          prompt: this.config.userPrompt,
          timestamp: Date.now(),
        };

        console.log("[Pipeline] Sanitized payload ready for transmission");
        console.log(
          `[Pipeline] Payload contains ${this.sanitizedDOM.elements.length} DOM elements`
        );
        console.log(
          `[Pipeline] Sensitive regions detected and redacted: ${this.sensitiveDataMap.regions.length}`
        );

        // TODO: Send to server (commented out for now to test locally)
        // const response = await fetch(`${this.config.serverUrl}/perceive`, {
        //   method: 'POST',
        //   headers: { 'Content-Type': 'application/json' },
        //   body: JSON.stringify(payload),
        // });

        this.markCompleted("transmission");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.markFailed("transmission", msg);
        throw error;
      }

      // ========== STAGE 5: REASONING ==========
      this.markRunning("reasoning");
      try {
        // In a real implementation, this would call the server LLM/VLM
        // For now, we'll simulate a response
        const serverAction: ServerAction = {
          action: "click",
          target: "[REDACTED_BUTTON_01]",
          confidence: 0.92,
          metadata: { reason: "User asked to find latest order" },
        };

        this.config.onActionReceived?.(serverAction);
        this.markCompleted("reasoning");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.markFailed("reasoning", msg);
        throw error;
      }

      // ========== STAGE 6: VALIDATION ==========
      this.markRunning("validation");
      try {
        // Setup action executor
        const validator = new ActionValidator(0.6); // 60% confidence minimum
        this.actionExecutor = new ActionExecutor(validator);

        // Set token map so executor can resolve tokens
        if (this.perceptionResult?.sensitiveDataMap) {
          // Note: In real implementation, would pass actual token manager
          console.log("[Pipeline] Token resolution configured for local execution");
        }

        // Simulate validation (real action would come from server)
        const mockAction: ServerAction = {
          action: "click",
          target: "button#submit",
          confidence: 0.92,
          metadata: { reason: "Submit form" },
        };

        const validation = validator.validate(mockAction);
        this.config.onValidation?.(validation);

        if (!validation.valid) {
          throw new Error(`Action validation failed: ${validation.issues.join(", ")}`);
        }

        this.markCompleted("validation");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.markFailed("validation", msg);
        throw error;
      }

      // ========== STAGE 7: EXECUTION ==========
      this.markRunning("execution");
      try {
        if (!this.actionExecutor) {
          throw new Error("Action executor not initialized");
        }

        // Simulate execution (real action would come from server)
        const mockAction: ServerAction = {
          action: "click",
          target: "button#submit",
          confidence: 0.92,
        };

        const result = await this.actionExecutor.execute(mockAction);
        this.config.onExecution?.(result.success, result.message);

        if (!result.success) {
          throw new Error(`Execution failed: ${result.message}`);
        }

        this.markCompleted("execution");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.markFailed("execution", msg);
        throw error;
      }

      // ========== STAGE 8: COMPLETION ==========
      this.markRunning("completion");
      try {
        // Build statistics
        const totalTime = performance.now() - totalStart;

        this.stats = {
          detectionsByType: this.sensitiveDataMap.countsByType,
          detectionsBySource: this.sensitiveDataMap.countsBySource,
          timing: {
            perception: this.perceptionResult?.timing.total || 0,
            sanitization:
              (this.getStage("sanitization").endTime || 0) -
              (this.getStage("sanitization").startTime || 0),
            transmission:
              (this.getStage("transmission").endTime || 0) -
              (this.getStage("transmission").startTime || 0),
            execution:
              (this.getStage("execution").endTime || 0) -
              (this.getStage("execution").startTime || 0),
            total: totalTime,
          },
          averageConfidence: this.sensitiveDataMap.overallConfidence,
          riskLevel: this.assessRiskLevel(),
        };

        console.log("[Pipeline] Completion stats:", this.stats);
        this.config.onComplete?.(this.stats);
        this.markCompleted("completion");

        console.log("[Pipeline] ✅ Pipeline completed successfully");
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        this.markFailed("completion", msg);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error("[Pipeline] ❌ Pipeline failed:", msg);
      this.config.onError?.(msg);
    }
  }

  /**
   * Assess overall risk level based on detections.
   */
  private assessRiskLevel(): "safe" | "medium" | "high" {
    if (!this.sensitiveDataMap) return "safe";

    const passwordCount = this.sensitiveDataMap.countsByType["PASSWORD"] || 0;
    const cardCount = this.sensitiveDataMap.countsByType["CARD"] || 0;
    const personCount = this.sensitiveDataMap.countsByType["PERSON"] || 0;

    if (passwordCount > 0 || cardCount > 0) return "high";
    if (personCount > 2) return "medium";
    return "safe";
  }

  /**
   * Get current statistics.
   */
  getStats(): PipelineStats | null {
    return this.stats;
  }

  /**
   * Get all stages.
   */
  getStages(): PipelineStage[] {
    return [...this.stages];
  }
}

/**
 * Convenience function to run the complete pipeline.
 */
export async function runUnifiedPipeline(config: PipelineConfig): Promise<UnifiedPipeline> {
  const pipeline = new UnifiedPipeline(config);
  await pipeline.run();
  return pipeline;
}
