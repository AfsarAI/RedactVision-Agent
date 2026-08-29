# RedactVision Agent — Security Model

## Security Goal

A compromised or curious remote reasoning service must not receive the user's raw sensitive screen information, and a malicious webpage or incorrect model response must not directly control the browser without local checks.

## Threats

- PII leakage
- credential leakage
- indirect prompt injection
- malicious webpage instructions
- fake/spoofed UI
- clickjacking-like deception
- hallucinated actions
- wrong target selection
- server compromise
- extension permission abuse
- accidental sensitive logging

## Controls

### Data boundary
Sanitize before network transmission.

### Local token map
Never transmit it.

### Untrusted page content
Treat page text/DOM as data, not as trusted instructions.

### Server actions
Treat all server output as untrusted.

### Local policy engine
Classify action risk and enforce allow/deny/confirm rules.

### Target validation
Confirm that the target exists and is appropriate before execution.

### High-risk confirmation
Require user confirmation for consequential actions such as payment, deletion, sending messages, credential entry, or other actions designated high-risk.

### Logging
Log action metadata and diagnostic state only. Never log raw PII, passwords, token maps, or secrets.

### Permissions
Use the minimum browser extension permissions necessary for the prototype.

## Privacy Test

A core regression test should prove:

```text
RAW TEST PAGE
   |
   v
LOCAL DETECTION
   |
   v
LOCAL TOKENIZATION
   |
   +--> token map remains local
   |
   v
NETWORK PAYLOAD
   |
   +--> contains [EMAIL_01]
   +--> does NOT contain real email
```
