# RedactVision Agent — API Contract

This is the conceptual contract. Update it whenever implementation changes.

## Client → Server: Sanitized Context

```json
{
  "request_id": "req_001",
  "page": {
    "url": "https://example.test/",
    "title": "Example Page"
  },
  "user_task": "Book a ticket for [PERSON_01]",
  "elements": [
    {
      "id": "submit-btn",
      "tag": "button",
      "type": "button",
      "role": "button",
      "text": "Submit",
      "selector": "#submit-btn",
      "bbox": {
        "x": 120,
        "y": 420,
        "width": 100,
        "height": 40
      }
    },
    {
      "id": "email",
      "tag": "input",
      "type": "email",
      "name": "email",
      "value": "[EMAIL_01]",
      "selector": "#email"
    }
  ],
  "visual_context": {
    "type": "sanitized",
    "image": null
  }
}
```

## Privacy requirements

The payload MUST NOT contain:
- token map;
- original sensitive values;
- raw password values;
- raw PII;
- unredacted screenshots;
- credentials/API keys.

## Server → Client: Structured Action

Example:

```json
{
  "request_id": "req_001",
  "action": "click",
  "target": {
    "id": "submit-btn",
    "selector": "#submit-btn",
    "description": "Submit button"
  },
  "value": null,
  "confidence": 0.97
}
```

Type example:

```json
{
  "request_id": "req_002",
  "action": "type",
  "target": {
    "id": "email",
    "selector": "#email"
  },
  "value": "[PROFILE:email]",
  "confidence": 0.95
}
```

The client resolves `[EMAIL_01]` page tokens or `[PROFILE:email]` local-profile
tokens only after validation and policy checks. Profile values are encrypted at
rest in the browser and are never included in the server request.

## Allowed actions

- `click`
- `type`
- `scroll`
- `navigate`
- `wait`

Do not add arbitrary code execution.

## Validation

Before execution:
1. parse JSON;
2. validate schema;
3. validate action type;
4. validate target;
5. check visibility/interactability where applicable;
6. check confidence/risk policy;
7. require confirmation when policy says so;
8. execute;
9. verify resulting state where practical.
