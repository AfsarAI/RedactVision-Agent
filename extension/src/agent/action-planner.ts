/**
 * RedactVision Agent - Action Planner
 *
 * Converts a natural-language user prompt + sanitized page context
 * into a structured PlannedAction.
 *
 * This planner runs LOCALLY and produces the action that the server
 * will return. It does NOT execute the action — that is the executor's job.
 *
 * Phase 8+ will replace the local planner with a server-side LLM call.
 * For now, the planner uses deterministic keyword + heuristic matching
 * so the full pipeline (perceive → plan → validate → execute) can be tested
 * end-to-end without a real LLM.
 */

import type { PlannedAction } from "../executor/action-executor";
import type { SanitizedPageDOM, SanitizedElement } from "../privacy/privacy-types";

export interface PlanningContext {
  sanitizedDOM: SanitizedPageDOM;
  /** History of actions already performed in this task. */
  actionHistory?: PlannedAction[];
}

const FIELD_KEYWORDS: Record<string, string[]> = {
  name: ["name", "full-name", "fullname", "first-name", "last-name"],
  email: ["email", "mail", "e-mail"],
  phone: ["phone", "mobile", "tel", "cell"],
  password: ["password", "passcode", "pass"],
  country: ["country"],
  message: ["message", "comment", "feedback", "note"],
};

const BUTTON_KEYWORDS: Record<string, string[]> = {
  submit: ["submit", "send", "register", "signup", "sign-up", "create", "go", "confirm"],
  cancel: ["cancel", "abort", "back", "close", "discard"],
  search: ["search", "find", "query"],
};

function findElementByField(elements: SanitizedElement[], fieldType: string): SanitizedElement | undefined {
  const kws = FIELD_KEYWORDS[fieldType] || [];
  for (const el of elements) {
    const id = (el.id || "").toLowerCase();
    const name = (el.name || "").toLowerCase();
    const aria = (el.ariaLabel || "").toLowerCase();
    for (const kw of kws) {
      if (id.includes(kw) || name.includes(kw) || aria.includes(kw)) {
        return el;
      }
    }
  }
  return undefined;
}

function findButtonByType(elements: SanitizedElement[], buttonType: string): SanitizedElement | undefined {
  const kws = BUTTON_KEYWORDS[buttonType] || [];
  for (const el of elements) {
    if (el.tag !== "button") continue;
    const id = (el.id || "").toLowerCase();
    const text = (el.text || "").toLowerCase();
    for (const kw of kws) {
      if (id.includes(kw) || text.includes(kw)) {
        return el;
      }
    }
  }
  return undefined;
}

function findAnySubmitButton(elements: SanitizedElement[]): SanitizedElement | undefined {
  for (const el of elements) {
    if (el.tag !== "button") continue;
    const id = (el.id || "").toLowerCase();
    if (id.includes("submit") || id.includes("btn")) return el;
  }
  return undefined;
}

/**
 * Extract the first significant token from a sanitized value field.
 * The DOM is already tokenized (e.g. value = "[EMAIL_01]"), so we just
 * look for the first token that matches the field's PII type.
 */
function pickTokenForField(sanitizedValue: string | null, fieldType: string): string | undefined {
  if (!sanitizedValue) return undefined;
  const typeMap: Record<string, string> = {
    email: "EMAIL",
    phone: "PHONE",
    password: "PASSWORD",
    name: "PERSON",
  };
  const type = typeMap[fieldType];
  if (!type) return undefined;
  const m = sanitizedValue.match(new RegExp(`\\[${type}_\\d+\\]`));
  return m ? m[0] : undefined;
}

/**
 * Plan an action from a user prompt and sanitized page context.
 *
 * Returns null if the prompt is uninterpretable.
 */
export function planAction(prompt: string, ctx: PlanningContext): PlannedAction | null {
  const p = prompt.toLowerCase().trim();
  const elements = ctx.sanitizedDOM.elements || [];

  // ----- SCROLL -----
  if (p.includes("scroll")) {
    const direction: "up" | "down" | "left" | "right" =
      p.includes("up") ? "up" :
      p.includes("left") ? "left" :
      p.includes("right") ? "right" :
      "down";

    let amount = 500;
    if (p.includes("bottom") || p.includes("end") || p.includes("to the end")) {
      amount = 99999;
    } else if (p.includes("top")) {
      amount = 99999;
      // For "scroll to top" we want a different effect — handled by direction
    } else {
      // Try to parse "scroll down 700" or "scroll 700"
      const m = p.match(/(\d+)\s*(px|pixels?)?/);
      if (m) amount = Math.min(parseInt(m[1], 10), 5000);
    }

    return {
      action: "scroll",
      direction,
      amount,
      confidence: 0.95,
      reasoning: `Interpreted as scroll ${direction} ${amount}px`,
    };
  }

  // ----- CLICK -----
  if (p.startsWith("click") || p.startsWith("press") || p.startsWith("tap") || p.startsWith("select the submit")) {
    // Try cancel first if mentioned
    if (p.includes("cancel")) {
      const btn = findButtonByType(elements, "cancel") || findAnySubmitButton(elements);
      if (btn) {
        return {
          action: "click",
          target: btn.selector,
          confidence: 0.95,
          reasoning: "Matched cancel/close button",
        };
      }
    }
    // Submit
    if (p.includes("submit") || p.includes("go") || p.includes("send") || p.includes("register") || p.includes("sign") || p.includes("create")) {
      const btn = findButtonByType(elements, "submit") || findAnySubmitButton(elements);
      if (btn) {
        return {
          action: "click",
          target: btn.selector,
          confidence: 0.96,
          reasoning: "Matched submit button",
        };
      }
    }
    // Generic click on a named element
    for (const el of elements) {
      if (el.tag === "button") {
        return {
          action: "click",
          target: el.selector,
          confidence: 0.85,
          reasoning: "Generic click on first button",
        };
      }
    }
    return null;
  }

  // "Submit the form" without "click" prefix
  if ((p.includes("submit") || p.includes("send")) && (p.includes("form") || p.endsWith("it"))) {
    const btn = findButtonByType(elements, "submit") || findAnySubmitButton(elements);
    if (btn) {
      return {
        action: "click",
        target: btn.selector,
        confidence: 0.95,
        reasoning: "Submit form → click submit button",
      };
    }
  }

  // ----- TYPE / FILL -----
  if (p.startsWith("fill") || p.startsWith("type") || p.startsWith("enter") || p.startsWith("input") || p.startsWith("set")) {
    // Determine which field
    let fieldType: string | null = null;
    if (p.includes("email") || p.includes("mail")) fieldType = "email";
    else if (p.includes("phone") || p.includes("mobile") || p.includes("tel")) fieldType = "phone";
    else if (p.includes("password") || p.includes("passcode")) fieldType = "password";
    else if (p.includes("name")) fieldType = "name";
    else if (p.includes("country")) fieldType = "country";
    else if (p.includes("message")) fieldType = "message";

    if (fieldType && fieldType !== "country" && fieldType !== "message") {
      const el = findElementByField(elements, fieldType);
      if (el) {
        // Prefer a literal value the user supplied ("fill name with X",
        // "type X into email", etc.) over token resolution. The user
        // already knows the literal — they typed it.
        const literal = extractLiteralValue(prompt, fieldType);
        if (literal !== null) {
          return {
            action: "type",
            target: el.selector,
            value: literal,
            confidence: 0.95,
            reasoning: `Fill ${fieldType} field ${el.selector} with literal "${truncate(literal, 30)}"`,
          };
        }
        // No literal — fall back to the token in the sanitized value
        // (e.g. [EMAIL_01]). If none, use an empty string (legitimate
        // "clear the field" semantics; the executor will accept "").
        const token = pickTokenForField(el.value, fieldType);
        return {
          action: "type",
          target: el.selector,
          value: token || "",
          confidence: 0.93,
          reasoning: token
            ? `Fill ${fieldType} field ${el.selector} with local token`
            : `Clear ${fieldType} field ${el.selector}`,
        };
      }
    }

    if (fieldType === "country" || p.includes("select") && p.includes("country")) {
      const el = findElementByField(elements, "country");
      if (el) {
        return {
          action: "select",
          target: el.selector,
          value: extractAfterKeyword(p, ["from country", "from the country", "from", "in country"]) || "india",
          confidence: 0.9,
          reasoning: "Select country option",
        };
      }
    }
  }

  // ----- SELECT (dropdown) -----
  if (p.startsWith("select") || p.startsWith("choose") || p.includes("choose")) {
    // Find any select element
    const selectEl = elements.find((el) => el.tag === "select");
    if (selectEl) {
      const value = extractAfterKeyword(p, ["select", "choose"]) || "india";
      return {
        action: "select",
        target: selectEl.selector,
        value,
        confidence: 0.9,
        reasoning: "Select dropdown option",
      };
    }
  }

  // ----- WAIT -----
  if (p.startsWith("wait") || p.startsWith("pause")) {
    return { action: "wait", amount: 1000, confidence: 0.95, reasoning: "Wait 1s" };
  }

  return null;
}

function extractAfterKeyword(prompt: string, keywords: string[]): string | undefined {
  for (const kw of keywords) {
    const idx = prompt.indexOf(kw);
    if (idx >= 0) {
      return prompt.substring(idx + kw.length).trim().split(/\s+/)[0];
    }
  }
  return undefined;
}

/**
 * Pull a literal value out of a "fill X with Y" / "type Y into X" / etc.
 * prompt. Returns the literal as a string, or null if the user did not
 * supply a value.
 *
 * The grammar splits into two patterns:
 *   - "VALUE_AFTER"  →  fill X with Y  /  set X to Y  /  fill X as Y
 *                        (Y is the value, comes after the keyword)
 *   - "VALUE_BEFORE" →  type Y into X  /  enter Y in X
 *                        (Y is the value, comes before the keyword)
 *
 * Supports:
 *   - Quoted:    fill name with "Mohd Afsar"   → "Mohd Afsar"
 *   - Quoted:    type "hello world" into name  → "hello world"
 *   - Unquoted:  fill name with Mohd Afsar     → "Mohd Afsar"
 *   - Unquoted:  type Mohd Afsar into name     → "Mohd Afsar"
 *   - Token:     fill name with [PERSON_01]    → "[PERSON_01]"
 */
function extractLiteralValue(prompt: string, _fieldType: string): string | null {
  const original = prompt;
  const lower = prompt.toLowerCase();

  // VALUE_AFTER keywords — value follows the keyword.
  const afterKeywords = [" with ", " as ", " to "];
  for (const kw of afterKeywords) {
    const i = lower.indexOf(kw);
    if (i < 0) continue;
    return extractAfter(original, i + kw.length);
  }

  // VALUE_BEFORE keywords — value precedes the keyword.
  const beforeKeywords = [" into ", " in "];
  for (const kw of beforeKeywords) {
    const i = lower.indexOf(kw);
    if (i < 0) continue;
    // The value is the chunk of the prompt BEFORE this keyword, but
    // we need to skip the leading verb ("type", "enter", "input").
    // Take everything before the keyword and trim leading verbs.
    let value = original.substring(0, i).trim();
    value = value.replace(/^(type|enter|input|put)\s+/i, "").trim();
    if (!value) return null;
    return cleanValue(value);
  }

  return null;
}

function extractAfter(original: string, startIdx: number): string | null {
  const trailing = original.substring(startIdx).trim();
  if (!trailing) return null;
  return cleanValue(trailing);
}

function cleanValue(raw: string): string | null {
  // Quoted: extract the inside of the first matching quote pair.
  const first = raw[0];
  if (first === '"' || first === "'") {
    const end = raw.indexOf(first, 1);
    if (end > 1) return raw.substring(1, end);
    return null;
  }
  // Unquoted: strip a single trailing period/question mark.
  let value = raw;
  if (value.endsWith(".") || value.endsWith("?")) {
    value = value.slice(0, -1);
  }
  return value.trim() || null;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "…";
}
