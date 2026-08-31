export interface DOMElementInfo {
  tag: string;
  id: string | null;
  classes: string[];
  type: string | null;
  name: string | null;
  text: string;
  value: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  /** Text content of the associated <label> element, if any.
   *  This is the primary signal the local LLM uses to determine
   *  what kind of data the field expects — not the field's name/id. */
  label: string;
  selector: string;
}

export interface PageDOM {
  url: string;
  title: string;
  elements: DOMElementInfo[];
}

/**
 * Generate a CSS selector that can be used to identify an element.
 */
function getSelector(element: Element): string {
  const htmlElement = element as HTMLElement;

  if (htmlElement.id) {
    return `#${CSS.escape(htmlElement.id)}`;
  }

  const name = htmlElement.getAttribute("name");

  if (name) {
    return `${element.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
  }

  const tag = element.tagName.toLowerCase();

  const parent = element.parentElement;

  if (!parent) {
    return tag;
  }

  const siblings = Array.from(parent.children).filter(
    (child) => child.tagName === element.tagName
  );

  if (siblings.length === 1) {
    return `${getSelector(parent)} > ${tag}`;
  }

  const index = siblings.indexOf(element) + 1;

  return `${getSelector(parent)} > ${tag}:nth-of-type(${index})`;
}

/**
 * Get the text of the <label> associated with an input element.
 * Checks: label[for], label > input, nearest label ancestor.
 */
function getLabelText(el: Element): string {
  const htmlEl = el as HTMLElement;

  // 1. Explicit label[for]
  if (htmlEl.id) {
    const labelFor = document.querySelector(`label[for="${CSS.escape(htmlEl.id)}"]`);
    if (labelFor) return (labelFor.textContent || "").trim().replace(/\s+/g, " ");
  }

  // 2. Label wrapping the input
  const parent = htmlEl.closest("label");
  if (parent) return (parent.textContent || "").trim().replace(/\s+/g, " ");

  // 3. Nearest form-group / fieldset container with a label
  const formGroup = htmlEl.closest("div, section, fieldset, td, li");
  if (formGroup) {
    const groupLabel = formGroup.querySelector("label");
    if (groupLabel) return (groupLabel.textContent || "").trim().replace(/\s+/g, " ");
    // Also capture preceding sibling text (e.g. label before input in a flex row)
    const prev = formGroup.previousElementSibling;
    if (prev && prev.tagName === "LABEL") {
      return (prev.textContent || "").trim().replace(/\s+/g, " ");
    }
  }

  // 4. aria-label on the input itself
  const aria = htmlEl.getAttribute("aria-label");
  if (aria) return aria.trim().replace(/\s+/g, " ");

  return "";
}

/**
 * Extract useful information from a single DOM element.
 */
function extractElement(element: Element): DOMElementInfo {
  const htmlElement = element as HTMLElement;
  const inputElement = element as HTMLInputElement;
  const isContentEditable = htmlElement.isContentEditable;

  return {
    tag: element.tagName.toLowerCase(),

    id: htmlElement.id || null,

    classes: Array.from(htmlElement.classList),

    type: htmlElement.getAttribute("type"),

    name: htmlElement.getAttribute("name"),

    text: (htmlElement.innerText || htmlElement.textContent || "")
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 500),

    label: getLabelText(element),

    value:
      "value" in inputElement
        ? inputElement.value || null
        : isContentEditable
        ? (htmlElement.innerText || htmlElement.textContent || "").trim() || null
        : null,

    placeholder: htmlElement.getAttribute("placeholder"),

    ariaLabel: htmlElement.getAttribute("aria-label"),

    selector: getSelector(element),
  };
}

/**
 * Extract the relevant interactive and textual DOM elements
 * from the current webpage.
 */
export function extractPageDOM(): PageDOM {
  const elements: DOMElementInfo[] = [];

  const selector = [
    "input",
    "textarea",
    "select",
    "button",
    "a",
    "img",
    "form",
    "[role]",
    "[aria-label]",
    "[contenteditable]"
  ].join(",");

  const domElements = document.querySelectorAll(selector);

  domElements.forEach((element) => {
    elements.push(extractElement(element));
  });

  return {
    url: window.location.href,
    title: document.title,
    elements
  };
}
