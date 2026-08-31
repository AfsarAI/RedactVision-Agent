/**
 * RedactVision Agent — Prompt Data Extractor
 *
 * Automatically extract personal data fields from user chat prompts.
 * This allows users to naturally share their details ("my name is X, email is Y")
 * without needing to manually save a profile first.
 *
 * Extraction is greedy but conservative:
 * - Detects: email, phone, name, address/city
 * - Only extracts fields that match clear patterns
 * - Avoids false positives by requiring pattern confidence
 */

import type { LocalProfileValues } from "./profile-store";

export interface ExtractedData {
  fields: LocalProfileValues;
  confidence: Record<keyof LocalProfileValues, number>; // 0-1 for each field
  rawMatches: Array<{ type: string; value: string }>;
}

/**
 * Extract personal data fields from user prompt text.
 * Returns the best matches found with confidence scores.
 */
export function extractDataFromPrompt(text: string): ExtractedData {
  if (!text || typeof text !== "string") {
    return {
      fields: {},
      confidence: {} as Record<keyof LocalProfileValues, number>,
      rawMatches: [],
    };
  }

  const lowerText = text.toLowerCase();
  const fields: LocalProfileValues = {};
  const confidence: Partial<Record<keyof LocalProfileValues, number>> = {};
  const rawMatches: Array<{ type: string; value: string }> = [];

  // ========== EMAIL ==========
  // Pattern: standard email regex
  const emailRegex = /([a-zA-Z0-9._%-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;
  const emailMatches = text.match(emailRegex);
  if (emailMatches && emailMatches.length > 0) {
    // Take the first match (most likely the user's email)
    fields.email = emailMatches[0];
    confidence.email = 0.95; // Very high confidence for email pattern
    rawMatches.push({ type: "EMAIL", value: emailMatches[0] });
  }

  // ========== PHONE ==========
  // Pattern: +91 XXXXX XXXXX or +1 XXX-XXX-XXXX or 10-digit
  const phoneRegex =
    /(?:\+?\d{1,3}[-.\s]?)?(?:\d{1,4}[-.\s]?){1,3}\d{1,4}(?![\d])/g;
  const phoneMatches = text.match(phoneRegex);
  if (phoneMatches && phoneMatches.length > 0) {
    // Filter for reasonable phone lengths (8-15 digits)
    const validPhones = phoneMatches.filter(
      (p) => p.replace(/\D/g, "").length >= 8
    );
    if (validPhones.length > 0) {
      fields.phone = validPhones[0].trim();
      confidence.phone = 0.85; // Good confidence for phone pattern
      rawMatches.push({ type: "PHONE", value: validPhones[0] });
    }
  }

  // ========== NAME ==========
  // Pattern 1: "my name is X" or "I am X" — capture until comma, period, or keyword
  // Use a more flexible approach: capture name, then trim to remove trailing keywords
  const nameFromSentenceRegex = /(?:my\s+name\s+(?:is|:)?\s*|i\s+(?:am|is)\s+)([a-zA-Z\s'-]+?)(?:\s+(?:my|is|and|email|phone|from|at|in|the)|[,.\n]|$)/i;
  const nameSentenceMatch = text.match(nameFromSentenceRegex);
  if (nameSentenceMatch && nameSentenceMatch[1]) {
    let extracted = nameSentenceMatch[1].trim();
    // Remove any trailing single letters or incomplete words
    extracted = extracted.replace(/\s+[a-z]?$/i, "").trim();
    // Only use if it looks like a real name (not too long, mostly alphabetic)
    if (extracted.length >= 2 && extracted.length < 80 && /^[a-zA-Z\s'-]{2,}$/.test(extracted)) {
      fields.name = extracted;
      confidence.name = 0.85;
      rawMatches.push({ type: "PERSON", value: extracted });
    }
  }

  // Pattern 2: Capitalize-separated words at sentence start (fallback)
  if (!fields.name && text.length > 0) {
    const capitalizedRegex = /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+/;
    const capMatch = text.match(capitalizedRegex);
    if (capMatch && capMatch[1]) {
      const extracted = capMatch[1];
      if (extracted.split(" ").length <= 3) {
        // Max 3 words (first middle last)
        fields.name = extracted;
        confidence.name = 0.65; // Lower confidence for positional match
        rawMatches.push({ type: "PERSON", value: extracted });
      }
    }
  }

  // ========== ADDRESS / CITY ==========
  // Pattern: "city is X" or "from X" (simple heuristic)
  const cityRegex =
    /(?:(?:city|location|address)\s+(?:is|:)?\s*|from\s+)([A-Z][a-zA-Z\s]{2,}?)(?:[,.\n]|$)/i;
  const cityMatch = text.match(cityRegex);
  if (cityMatch && cityMatch[1]) {
    const extracted = cityMatch[1].trim();
    if (extracted.length < 80 && !/\d{10,}/.test(extracted)) {
      // Avoid long strings and ZIP codes
      fields.address = extracted;
      confidence.address = 0.75;
      rawMatches.push({ type: "ADDRESS", value: extracted });
    }
  }

  return {
    fields,
    confidence: confidence as Record<keyof LocalProfileValues, number>,
    rawMatches,
  };
}

/**
 * Extract data and return only fields with confidence above threshold.
 * @param text User prompt text
 * @param minConfidence Minimum confidence threshold (0-1), default 0.6
 */
export function extractDataFromPromptFiltered(
  text: string,
  minConfidence = 0.6
): LocalProfileValues {
  const extracted = extractDataFromPrompt(text);
  const filtered: LocalProfileValues = {};

  for (const [key, value] of Object.entries(extracted.fields)) {
    const conf = extracted.confidence[key as keyof LocalProfileValues] || 0;
    if (conf >= minConfidence && value) {
      filtered[key as keyof LocalProfileValues] = value;
    }
  }

  return filtered;
}

/**
 * Check if extracted data has any meaningful fields.
 */
export function hasExtractedData(data: LocalProfileValues): boolean {
  return Object.values(data).some((v) => !!v);
}
