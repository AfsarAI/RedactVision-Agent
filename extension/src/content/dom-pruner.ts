/**
 * RedactVision Agent — DOM Snapshot Pruner & Payload Reducer
 *
 * Strips non-essential elements, noisy tags, heavy inline styles,
 * and data attributes to generate a lightweight DOM snapshot,
 * reducing network transfer latency and serialization overhead.
 */

const NOISE_SELECTORS = "script, style, svg, noscript, link, meta, head, iframe";
const MAX_PRUNED_DOM_CHARS = 12000;

/**
 * Generates a lightweight, pruned DOM snapshot for agent perception.
 * @returns {string} Cleaned HTML string
 */
export function getPrunedDomSnapshot(rootNode: Element = document.body): string {
  if (!rootNode) return "";

  const clone = rootNode.cloneNode(true) as Element;

  // 1. Remove noisy/irrelevant structural tags
  clone.querySelectorAll(NOISE_SELECTORS).forEach((el) => el.remove());

  // 2. Strip inline styles and heavy data attributes (preserve data-testid and aria tags)
  const allElements = clone.querySelectorAll("*");
  allElements.forEach((el) => {
    el.removeAttribute("style");
    // Remove heavy data-attributes except test IDs and semantic tags
    Array.from(el.attributes).forEach((attr) => {
      if (attr.name.startsWith("data-") && attr.name !== "data-testid" && attr.name !== "data-item-id") {
        el.removeAttribute(attr.name);
      }
    });
  });

  const cleanHtml = clone.innerHTML.trim().replace(/\s+/g, " ");

  // 3. Cap character length to protect LLM context windows and speed up transfer
  return cleanHtml.length > MAX_PRUNED_DOM_CHARS
    ? cleanHtml.substring(0, MAX_PRUNED_DOM_CHARS) + "... [Truncated]"
    : cleanHtml;
}
