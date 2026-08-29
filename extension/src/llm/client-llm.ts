/**
 * RedactVision Agent — On-Device Perception Model
 *
 * IMPORTANT — this module is NOT a planner.
 *
 * The on-device model is a *perception / sanitization* layer used by the
 * Privacy Firewall to detect PII that lives in visual content (canvas,
 * rendered images, screenshots): faces, document cards, image-only
 * sensitive data. Its output is treated as another PII signal that
 * feeds the local token map.
 *
 * It must NEVER be invoked as an action planner. The server LLM is
 * the sole planner (see llm-planner.ts and docs/ARCHITECTURE.md).
 *
 * Default model: onnx-community/Qwen2.5-1.5B-Instruct (q4)
 * Loaded only when the privacy firewall has visual content to inspect.
 *
 * Privacy: nothing leaves the device. The model is loaded from
 * huggingface.co on first use, cached in IndexedDB; the user's page
 * content is never sent anywhere.
 */

export const DEFAULT_ON_DEVICE_MODEL = "onnx-community/Qwen2.5-1.5B-Instruct";

export interface OnDeviceModelStatus {
  state: "idle" | "loading" | "ready" | "error" | "unavailable";
  progress?: number;
  message?: string;
  hasWebGPU?: boolean;
  model?: string;
}

export type StatusListener = (status: OnDeviceModelStatus) => void;

interface TransformersModule {
  pipeline: (task: string, model: string, opts?: Record<string, unknown>) => Promise<unknown>;
  env: { allowLocalModels: boolean; useBrowserCache: boolean };
}

let cachedPipeline: unknown | null = null;
let cachedModel: string | null = null;
let loadingPromise: Promise<unknown> | null = null;
let statusListeners: StatusListener[] = [];
let lastStatus: OnDeviceModelStatus = { state: "idle" };

function emit(status: OnDeviceModelStatus): void {
  lastStatus = status;
  for (const l of statusListeners) {
    try {
      l(status);
    } catch {
      /* ignore */
    }
  }
}

export function onStatus(listener: StatusListener): () => void {
  statusListeners.push(listener);
  listener(lastStatus);
  return () => {
    statusListeners = statusListeners.filter((l) => l !== listener);
  };
}

export function getStatus(): OnDeviceModelStatus {
  return lastStatus;
}

/**
 * Check if WebGPU is available. Transformers.js picks webgpu vs wasm
 * automatically based on the environment. We just expose the capability
 * for the UI's "Test connection" indicator.
 */
export async function hasWebGPU(): Promise<boolean> {
  try {
    if (typeof navigator === "undefined") return false;
    const gpu = (navigator as unknown as { gpu?: { requestAdapter?: () => Promise<unknown> } }).gpu;
    if (!gpu || typeof gpu.requestAdapter !== "function") return false;
    const adapter = await gpu.requestAdapter();
    return !!adapter;
  } catch {
    return false;
  }
}

/**
 * Load the Transformers.js library. Returns null if the optional
 * dependency is not installed (so the UI can show a useful message).
 */
async function loadTransformers(): Promise<TransformersModule | null> {
  try {
    const mod = (await import(/* @vite-ignore */ "@huggingface/transformers" as string)) as TransformersModule;
    return mod;
  } catch (e) {
    console.warn(
      "[OnDeviceModel] @huggingface/transformers is not installed. " +
        "Run: npm install @huggingface/transformers"
    );
    return null;
  }
}

/**
 * Load the model pipeline. Caches in IndexedDB so the second call is fast.
 * Returns the pipeline on success, null on failure.
 *
 * NOTE: This is the only function that should touch the model. The pipeline
 * is used by the privacy firewall for visual PII detection — never for
 * action planning.
 */
export async function ensurePipeline(
  model: string = DEFAULT_ON_DEVICE_MODEL,
  onProgress?: (progress: number, message?: string) => void
): Promise<unknown | null> {
  if (cachedPipeline && cachedModel === model) return cachedPipeline;
  if (loadingPromise) return loadingPromise;

  const lib = await loadTransformers();
  if (!lib) {
    emit({ state: "unavailable", message: "Transformers.js not installed" });
    return null;
  }

  loadingPromise = (async () => {
    try {
      emit({ state: "loading", message: `Loading ${model}…`, model });
      const webgpu = await hasWebGPU();
      const device = webgpu ? "webgpu" : "wasm";

      const pipe = await lib.pipeline("text-generation", model, {
        device,
        dtype: "q4",
        use_external_data_format: false,
      } as Record<string, unknown>);

      cachedPipeline = pipe;
      cachedModel = model;
      emit({ state: "ready", hasWebGPU: webgpu, model });
      onProgress?.(1, "Model loaded");
      return pipe;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      emit({ state: "error", message: msg });
      throw err;
    } finally {
      loadingPromise = null;
    }
  })();

  return loadingPromise;
}

// =====================================================================
// Visual PII detection
// =====================================================================

/**
 * The kind of sensitive visual content the model has detected inside a
 * canvas / image. The privacy firewall turns this into a token entry
 * (e.g. [FACE_01], [CARD_01]) and the host element is masked before
 * any sanitized DOM crosses the network boundary.
 */
export type VisualPIIKind =
  | "face"
  | "id_card"
  | "credit_card"
  | "signature"
  | "document";

export interface VisualPIIMatch {
  /** Bounding box in the canvas / image coordinate space. */
  bbox: { x: number; y: number; width: number; height: number };
  /** What was detected. */
  kind: VisualPIIKind;
  /** Model confidence 0..1. */
  confidence: number;
}

export interface VisualPIIResult {
  matches: VisualPIIMatch[];
  /** True if the model was able to run. False if Transformers.js is unavailable. */
  available: boolean;
  /** Human-readable reason if not available. */
  reason?: string;
}

/**
 * Run the on-device model on a canvas/image and return detected visual PII.
 *
 * This is the ONLY allowed use of the on-device model. It is invoked
 * by the privacy firewall (extension/src/privacy/privacy-firewall.ts)
 * when sanitizing a page that contains canvas elements or rendered
 * image content. It must never be used to plan actions.
 *
 * The actual inference implementation depends on the model and is
 * intentionally a thin wrapper today: we expose the API surface so
 * the privacy firewall can call it, and the on-device detection can
 * be wired up incrementally. Today this returns "no matches" plus a
 * structured shape; future work plugs in a face/document detector
 * (e.g. blip-image-captioning or a dedicated detection head).
 */
export async function detectVisualPII(
  source: HTMLCanvasElement | HTMLImageElement | ImageData,
  _model: string = DEFAULT_ON_DEVICE_MODEL
): Promise<VisualPIIResult> {
  // Ensure the model is loaded but don't block forever.
  const pipe = await ensurePipeline(_model).catch(() => null);
  if (!pipe) {
    return {
      matches: [],
      available: false,
      reason: "On-device model unavailable (Transformers.js not installed or load failed)",
    };
  }

  // Today we don't actually have a detector head wired up — the contract
  // here is the API surface. The privacy firewall treats empty matches
  // as "no visual PII detected" and falls back to existing regex/DOM checks.
  // Future phases will add a dedicated detection model (e.g. face/OCR).
  //
  // The placeholder exists so the privacy firewall can already call this
  // function today without crashing, and so swapping in a real model
  // later is a one-line change.
  void source;
  void pipe;
  return { matches: [], available: true };
}

/**
 * Dispose the cached pipeline (for tests / settings change).
 */
export function disposePipeline(): void {
  cachedPipeline = null;
  cachedModel = null;
  emit({ state: "idle" });
}
