/**
 * RedactVision Agent — Debounced Mutation Observer
 *
 * Prevents mutation observer loops from causing CPU lockups during
 * rapid scrolling, live chat streaming, or continuous text entry.
 */

export interface DebouncedObserverController {
  start: (targetNode?: Node) => void;
  stop: () => void;
}

/**
 * Initializes a debounced mutation observer for real-time tracking (e.g. chat feeds, form updates).
 * @param {Function} callback - Function to execute after DOM changes settle
 * @param {number} delay - Debounce threshold in milliseconds (default: 300ms)
 */
export function createDebouncedObserver(
  callback: (mutations: MutationRecord[]) => void,
  delay = 300
): DebouncedObserverController {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  let accumulatedMutations: MutationRecord[] = [];

  const observer = new MutationObserver((mutations) => {
    accumulatedMutations.push(...mutations);

    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      const recordsToProcess = [...accumulatedMutations];
      accumulatedMutations = [];
      timeoutId = null;
      callback(recordsToProcess);
    }, delay);
  });

  return {
    start: (targetNode: Node = document.body) => {
      if (targetNode) {
        observer.observe(targetNode, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
    },
    stop: () => {
      observer.disconnect();
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      accumulatedMutations = [];
    },
  };
}
