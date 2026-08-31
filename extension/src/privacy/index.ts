/**
 * RedactVision Agent - Privacy Module Exports
 */

export { PrivacyFirewall } from "./privacy-firewall";

export { redactScreenshot, generateSanitizedVisualSummary } from "./visual-redaction-engine";
export type { RedactionOptions, RedactionResult, SanitizedVisualSummary } from "./visual-redaction-engine";

export { detectSensitiveData } from "./pii-detector";
export type { DetectionSource } from "./pii-detector";

export type {
  SensitiveEntityType,
  SensitiveMatch,
  TokenRecord,
  SanitizedElement,
  SanitizedPageDOM,
} from "./privacy-types";
