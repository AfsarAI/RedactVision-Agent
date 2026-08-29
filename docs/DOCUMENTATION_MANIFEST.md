# Supplied Documentation Manifest

This directory contains the source materials provided for the RedactVision Agent project.

| File | Role | Keep? | Claude usage |
|---|---|---:|---|
| `SIH26171_ByteForce-v2(1).pdf` | SIH internal PPT/submission; contains official PS framing, team, proposed solution, novelty, technical approach, tech stack, risks, impact, references, summary | YES | Background + SIH requirements + presentation alignment |
| `some context regarding this PS research(3).txt` | Large combined research/context document containing PS details, architecture alternatives, PII pipeline, redaction, action schema, security, datasets, benchmarking, roadmap, demo strategy | YES | Detailed design/reference; treat claims as research notes until verified |
| `Deep Research Prompt — SIH Problem Statement 26171(3).md` | Research prompt/specification describing what should be investigated and how the solution should be evaluated | YES | Research intent and coverage checklist; not an implementation spec by itself |
| `Privacy-Preserving Agentic Browser Workflow (3)(1).png` | Architecture visual showing trusted on-device zone, privacy firewall, semantic token replacement, network boundary, server VLM, local validation/execution | YES | Visual architecture reference |

## Important interpretation

The documents overlap heavily. They should not all be copied verbatim into `CLAUDE.md`.

`CLAUDE.md` contains the concise engineering rules and invariants. The original materials remain in `docs/` for detailed reference.

Known naming clarification:
- Current product: **RedactVision Agent**
- `PrivaSight` appears in older research notes as a proposed/working name. Do not rename the project to PrivaSight.

Known architecture clarification:
- The workflow image visually places stages in the order 1 → 2 → 3 → 5 → 4 for layout reasons.
- The logical system order is input → privacy → tokenization → server reasoning → local validation/execution, with the network boundary between client and server.

Known claim policy:
- Numbers in the research/PPT such as latency, RAM, recall, and “100%/0%” privacy statements are targets or claims to verify unless supported by our own benchmark or an authoritative source.
