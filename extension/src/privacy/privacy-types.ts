export type SensitiveEntityType =
  | "EMAIL"
  | "PHONE"
  | "PASSWORD"
  | "CARD"
  | "AADHAAR"
  | "PERSON";

export interface SensitiveMatch {
  type: SensitiveEntityType;
  value: string;
  start: number;
  end: number;
}

export interface TokenRecord {
  token: string;
  type: SensitiveEntityType;
  originalValue: string;
}

export interface SanitizedElement {
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

export interface SanitizedPageDOM {
  url: string;
  title: string;
  elements: SanitizedElement[];
}