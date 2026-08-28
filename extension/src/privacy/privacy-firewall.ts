import { extractPageDOM } from "../content/dom-extractor";

import {
  DOMElementInfo
} from "../content/dom-extractor";

import {
  SanitizedElement,
  SanitizedPageDOM,
  SensitiveEntityType,
  TokenRecord
} from "./privacy-types";

import {
  detectSensitiveData
} from "./pii-detector";

export class PrivacyFirewall {
  /*
   * IMPORTANT:
   *
   * This mapping stays inside the browser.
   * It must NEVER be sent to the server.
   */
  private tokenMap =
    new Map<string, TokenRecord>();

  private tokenCounters: Record<
    SensitiveEntityType,
    number
  > = {
    EMAIL: 0,
    PHONE: 0,
    PASSWORD: 0,
    CARD: 0,
    AADHAAR: 0,
    PERSON: 0
  };

  private getToken(
    type: SensitiveEntityType,
    originalValue: string
  ): string {
    /*
     * Reuse an existing token if the same
     * sensitive value appears again.
     */
    for (
      const record of this.tokenMap.values()
    ) {
      if (
        record.type === type &&
        record.originalValue === originalValue
      ) {
        return record.token;
      }
    }

    this.tokenCounters[type] += 1;

    const token =
      `[${type}_${String(
        this.tokenCounters[type]
      ).padStart(2, "0")}]`;

    this.tokenMap.set(token, {
      token,
      type,
      originalValue
    });

    return token;
  }

  private sanitizeText(
    text: string,
    element: DOMElementInfo,
    source:
      | "text"
      | "value"
      | "placeholder"
      | "ariaLabel"
  ): string {
    if (!text) {
      return text;
    }

    const matches =
      detectSensitiveData(
        text,
        {
          tag: element.tag,
          type: element.type,
          name: element.name,
          id: element.id,
          placeholder: element.placeholder,
          ariaLabel: element.ariaLabel,
          source
        }
      );

    if (matches.length === 0) {
      return text;
    }

    let sanitized = "";
    let cursor = 0;

    for (const match of matches) {
      sanitized += text.slice(
        cursor,
        match.start
      );

      const token =
        this.getToken(
          match.type,
          match.value
        );

      sanitized += token;

      cursor = match.end;
    }

    sanitized += text.slice(cursor);

    return sanitized;
  }

  private sanitizeElement(
    element: DOMElementInfo
  ): SanitizedElement {
    const sanitizedValue =
      element.value !== null
        ? this.sanitizeText(
            element.value,
            element,
            "value"
          )
        : null;

    return {
      tag: element.tag,

      id: element.id,

      classes: [
        ...element.classes
      ],

      type: element.type,

      name: element.name,

      text: this.sanitizeText(
        element.text,
        element,
        "text"
      ),

      value: sanitizedValue,

      placeholder:
        element.placeholder !== null
          ? this.sanitizeText(
              element.placeholder,
              element,
              "placeholder"
            )
          : null,

      ariaLabel:
        element.ariaLabel !== null
          ? this.sanitizeText(
              element.ariaLabel,
              element,
              "ariaLabel"
            )
          : null,

      selector: element.selector
    };
  }

  public sanitizePage(
    page: ReturnType<
      typeof extractPageDOM
    >
  ): SanitizedPageDOM {
    return {
      url: page.url,

      title: page.title,

      elements:
        page.elements.map(
          (element) =>
            this.sanitizeElement(
              element
            )
        )
    };
  }

  /*
   * LOCAL ONLY.
   *
   * This mapping will later be used by the
   * local action executor to restore tokens.
   *
   * NEVER send this to the server.
   */
  public getLocalTokenMap():
    TokenRecord[] {
    return Array.from(
      this.tokenMap.values()
    );
  }

  /*
   * LOCAL ONLY.
   *
   * Used later when an action needs to
   * resolve [EMAIL_01] back to the real value.
   */
  public resolveToken(
    token: string
  ): string | null {
    return (
      this.tokenMap.get(token)
        ?.originalValue ?? null
    );
  }
}