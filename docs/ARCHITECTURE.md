# RedactVision Agent — Architecture

## Logical Flow

```text
                    USER
                     |
                     v
              ACTIVE BROWSER TAB
                     |
                     v
          +-----------------------+
          | Manifest V3 Extension |
          +-----------------------+
             |       |        |
             |       |        +--> Popup / Policy UI
             |       |
             |       +----------> Background Service Worker
             |
             v
        Content Script
             |
             +--> DOM / safe element metadata
             |
             +--> visual state when required
             |
             v
     LOCAL PRIVACY FIREWALL
             |
             +--> DOM semantic detector
             +--> regex / heuristics
             +--> optional local NER/OCR
             +--> optional local CV
             |
             v
     REDACTION + TOKENIZATION
             |
             +--> sanitized context
             |
             +--> LOCAL TOKEN MAP (never transmitted)
             |
             v
      === NETWORK BOUNDARY ===
             |
             v
       FASTAPI GATEWAY
             |
             v
      SERVER-SIDE VLM/LLM
             |
             v
       STRUCTURED ACTION
             |
             v
      === NETWORK BOUNDARY ===
             |
             v
       LOCAL VALIDATOR
             |
             +--> schema check
             +--> target check
             +--> risk/policy check
             +--> confirmation if required
             |
             v
      LOCAL TOKEN RESOLUTION
             |
             v
      BROWSER EXECUTOR
             |
             +--> click
             +--> type
             +--> scroll
             +--> navigate
             +--> wait
             |
             v
          NEW PAGE STATE
             |
             +--------> re-perceive / re-sanitize / re-reason
```

## Trusted Zone

The client owns:
- raw DOM;
- raw visual state;
- sensitive values;
- token map;
- redaction decisions;
- local policy;
- final execution.

## Untrusted/remote zone

The server receives only sanitized information.

The server may reason about tokens such as `[PERSON_01]` or `[EMAIL_01]`, but must not receive the token-to-original-value mapping.

## Grounding

Use a hierarchy:
1. stable DOM ID/selector;
2. semantic element attributes;
3. accessibility role/name;
4. geometry/coordinates as fallback.

## Visual Context

Do not automatically send a full screenshot. Prefer:
- sanitized structured DOM;
- accessibility/role metadata;
- bounding boxes;
- OCR text;
- sanitized image crops when necessary.

The visual workflow image supplied with the project illustrates this separation between the on-device trusted zone and the server zone.
