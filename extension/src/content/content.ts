import { extractPageDOM } from "./dom-extractor";
import { PrivacyFirewall } from "../privacy/privacy-firewall";

console.log(
  "RedactVision Agent: Content Script Loaded"
);

/*
 * Capture raw DOM locally.
 */
const rawPageDOM = extractPageDOM();

/*
 * Run privacy firewall locally.
 */
const privacyFirewall =
  new PrivacyFirewall();

const sanitizedPageDOM =
  privacyFirewall.sanitizePage(
    rawPageDOM
  );

/*
 * Do NOT log rawPageDOM.
 *
 * Future server communication must use
 * sanitizedPageDOM only.
 */
console.log(
  "RedactVision Agent: Sanitized Page DOM"
);

console.log(
  sanitizedPageDOM
);

/*
 * LOCAL ONLY.
 *
 * This is for development/testing.
 * The token map must never be sent to
 * the server.
 */
console.log(
  "RedactVision Agent: Local Token Count",
  privacyFirewall
    .getLocalTokenMap()
    .length
);

console.log(
  "RedactVision Agent: Local Token Map",
  privacyFirewall
    .getLocalTokenMap()
);