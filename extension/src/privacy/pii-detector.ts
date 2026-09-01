import {
  SensitiveEntityType,
  SensitiveMatch
} from "./privacy-types";

export type DetectionSource =
  | "text"
  | "value"
  | "placeholder"
  | "ariaLabel";

export interface DetectionContext {
  tag: string;
  type: string | null;
  name: string | null;
  id: string | null;
  placeholder: string | null;
  ariaLabel: string | null;
  label?: string | null;
  source: DetectionSource;
}

function createMatch(
  type: SensitiveEntityType,
  value: string,
  start: number
): SensitiveMatch {
  return {
    type,
    value,
    start,
    end: start + value.length
  };
}

function detectEmails(
  text: string
): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  const regex =
    /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

  for (const match of text.matchAll(regex)) {
    if (match.index !== undefined) {
      matches.push(
        createMatch(
          "EMAIL",
          match[0],
          match.index
        )
      );
    }
  }

  return matches;
}

function detectPhones(
  text: string,
  context: DetectionContext
): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  const contextText = [
    context.type,
    context.name,
    context.id,
    context.placeholder,
    context.ariaLabel,
    context.label
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const looksLikePhoneField =
    context.type === "tel" ||
    contextText.includes("phone") ||
    contextText.includes("mobile") ||
    contextText.includes("tel") ||
    contextText.includes("contact");

  const phoneRegexes = [
    /\b(?:\+91[\s-]?)?[6-9]\d{9}\b/g,
    /\b(?:\+?1[\s-]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
    /\b(?:\+\d{1,3}[-.\s]?)?\d{10,14}\b/g,
    /\b\d{10}\b/g,
  ];

  for (const regex of phoneRegexes) {
    for (const match of text.matchAll(regex)) {
      if (match.index !== undefined) {
        matches.push(
          createMatch(
            "PHONE",
            match[0],
            match.index
          )
        );
      }
    }
  }

  return matches;
}

function luhnCheck(digits: string): boolean {
  let sum = 0;
  let alternate = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits.substring(i, i + 1), 10);
    if (alternate) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alternate = !alternate;
  }
  return sum % 10 === 0;
}

function detectCards(
  text: string
): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  const regex =
    /\b(?:\d[ -]*?){13,19}\b/g;

  for (const match of text.matchAll(regex)) {
    if (match.index !== undefined) {
      const digits =
        match[0].replace(/\D/g, "");

      if (
        digits.length >= 13 &&
        digits.length <= 19 &&
        luhnCheck(digits)
      ) {
        matches.push(
          createMatch(
            "CARD",
            match[0],
            match.index
          )
        );
      }
    }
  }

  return matches;
}

function detectAadhaar(
  text: string
): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  const regex =
    /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

  for (const match of text.matchAll(regex)) {
    if (match.index !== undefined) {
      matches.push(
        createMatch(
          "AADHAAR",
          match[0],
          match.index
        )
      );
    }
  }

  return matches;
}

function detectPassword(
  text: string,
  context: DetectionContext
): SensitiveMatch[] {
  const contextText = [
    context.type,
    context.name,
    context.id,
    context.placeholder,
    context.ariaLabel,
    context.label
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const isPasswordField =
    context.type === "password" ||
    contextText.includes("password") ||
    contextText.includes("passcode");

  if (!isPasswordField || !text) {
    return [];
  }

  return [
    createMatch(
      "PASSWORD",
      text,
      0
    )
  ];
}

function detectPerson(
  text: string,
  context: DetectionContext
): SensitiveMatch[] {
  const matches: SensitiveMatch[] = [];

  const contextText = [
    context.name,
    context.id,
    context.placeholder,
    context.ariaLabel,
    context.label
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  const looksLikeNameField =
    contextText.includes("name") ||
    contextText.includes("person") ||
    contextText.includes("applicant") ||
    contextText.includes("full name");

  if (
    looksLikeNameField &&
    /^[A-Za-z]+(?:\s+[A-Za-z]+){0,3}$/.test(
      text.trim()
    )
  ) {
    matches.push(
      createMatch(
        "PERSON",
        text.trim(),
        0
      )
    );

    return matches;
  }

  const contextualRegex =
    /\b(?:contact|for|from|to|by|with)\s+([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})?)/g;

  for (
    const match of text.matchAll(contextualRegex)
  ) {
    const person = match[1];

    if (
      match.index !== undefined &&
      person
    ) {
      const start =
        match.index +
        match[0].indexOf(person);

      matches.push(
        createMatch(
          "PERSON",
          person,
          start
        )
      );
    }
  }

  return matches;
}

export function detectSensitiveData(
  text: string,
  context: DetectionContext
): SensitiveMatch[] {
  if (!text) {
    return [];
  }

  /*
   * These detectors are safe to run on every source.
   */
  const matches: SensitiveMatch[] = [
    ...detectEmails(text),
    ...detectPhones(text, context),
    ...detectCards(text),
    ...detectAadhaar(text)
  ];

  /*
   * Context-dependent detectors should only run on
   * actual page text/value.
   *
   * This prevents false positives such as:
   *
   * "Enter your full name"
   * "Enter your password"
   *
   * being treated as actual PII.
   */
  if (
    context.source === "text" ||
    context.source === "value"
  ) {
    matches.push(
      ...detectPassword(
        text,
        context
      ),
      ...detectPerson(
        text,
        context
      )
    );
  }

  if (matches.length === 0) {
    return [];
  }

  /*
   * Sort by starting position.
   * If two matches overlap, prefer the longer match.
   */
  matches.sort((a, b) => {
    if (a.start !== b.start) {
      return a.start - b.start;
    }

    return (
      (b.end - b.start) -
      (a.end - a.start)
    );
  });

  const filtered: SensitiveMatch[] = [];

  for (const match of matches) {
    const overlaps =
      filtered.some(
        (existing) =>
          match.start < existing.end &&
          match.end > existing.start
      );

    if (!overlaps) {
      filtered.push(match);
    }
  }

  return filtered;
}