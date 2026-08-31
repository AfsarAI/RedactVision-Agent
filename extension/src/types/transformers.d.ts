/**
 * Minimal type declaration for @huggingface/transformers.
 *
 * The package is an OPTIONAL dependency and is only imported lazily by
 * the (currently unwired) perception engines (cv-engine / ner-engine).
 * Since it is not installed by default, tsc needs this stub so
 * `npm run typecheck` passes. Runtime code paths guard on availability,
 * so the loose `any` typing is acceptable here.
 */
declare module "@huggingface/transformers" {
  export const env: {
    allowLocalModels?: boolean;
    useBrowserCache?: boolean;
    [key: string]: unknown;
  };

  export function pipeline(
    task: string,
    model?: string,
    options?: Record<string, unknown>
  ): Promise<unknown>;

  // Fall back for any other named exports the engines may rely on.
  const x: any;
  export = x;
}