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
 * Extract useful information from a single DOM element.
 */
function extractElement(element: Element): DOMElementInfo {
  const htmlElement = element as HTMLElement;
  const inputElement = element as HTMLInputElement;

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

    value:
      "value" in inputElement
        ? inputElement.value || null
        : null,

    placeholder: htmlElement.getAttribute("placeholder"),

    ariaLabel: htmlElement.getAttribute("aria-label"),

    selector: getSelector(element)
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
    "[aria-label]"
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