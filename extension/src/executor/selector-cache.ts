/**
 * RedactVision Agent — Element Selector Cache (Fast-Path Execution)
 *
 * Eliminates redundant DOM traversals by caching target selectors for the
 * duration of the active page interaction lifecycle.
 */

export class SelectorCache {
  private static cache = new Map<string, string>();

  /**
   * Look up an element from the fast-path selector cache and verify it still exists in the DOM.
   */
  static get(identifier: string): Element | null {
    if (!identifier) return null;
    const normalizedKey = identifier.trim().toLowerCase();

    if (this.cache.has(normalizedKey)) {
      const selector = this.cache.get(normalizedKey)!;
      try {
        const el = document.querySelector(selector);
        if (el) return el; // Valid element in live DOM
        // Element was removed/re-rendered -> bust cache
        this.cache.delete(normalizedKey);
      } catch {
        this.cache.delete(normalizedKey);
      }
    }
    return null;
  }

  /**
   * Cache a successful selector mapping for fast-path reuse.
   */
  static set(identifier: string, selector: string): void {
    if (!identifier || !selector) return;
    const normalizedKey = identifier.trim().toLowerCase();
    this.cache.set(normalizedKey, selector);
  }

  /**
   * Invalidate and clear the selector cache (e.g. on navigation or page reset).
   */
  static clear(): void {
    this.cache.clear();
  }
}
