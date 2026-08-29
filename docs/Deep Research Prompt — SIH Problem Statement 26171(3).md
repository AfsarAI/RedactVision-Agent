# Deep Research & Solution Development Prompt for SIH Problem Statement 26171

I am participating in the **Smart India Hackathon (SIH)** and I need you to perform **deep, comprehensive technical research** on my selected problem statement and then prepare a detailed research report in **simple Hinglish**.

I have uploaded my **SIH PPT template**. You MUST study the uploaded PPT carefully first and understand exactly what information the SIH presentation expects.

I am also providing the complete Problem Statement details below.

---

# 1. MY SIH PROBLEM STATEMENT

**Problem Statement ID:** 26171

**Problem Statement Title:**  
**On-device Visual Perception for Light-weight Browser Agents**

**Organization:**  
Indian Space Research Organisation (ISRO)

**Department:**  
Department of Space / Indian Space Research Organisation

**Category:**  
Software

**Theme:**  
Miscellaneous

**Dataset:**  
Any open-source data can be used. Use cases for evaluation will be provided during the finale.

---

## Problem Statement Description

Background AI agents are becoming omnipresent in the current era and can play an important role in our digital interactions. If an agentic AI pipeline has access to our visual context and screen states, it can assist users in complex workflows and automate many tasks.

Most agentic AI pipelines are deployed on the server side, which limits the type of data that a user can share with it. A local agent deployed on the user's machine, particularly inside the browser, can eliminate the need to share sensitive data with the server.

However, local systems generally have fewer computational resources than servers and may be unable to host a full-fledged AI pipeline. Therefore, only non-sensitive information such as the structure of the screen, application fields, etc. should be sent to the server for processing.

Modern browser technologies such as **WebGPU** and **WebAssembly**, along with local inference libraries such as **ONNX Runtime Web** and **Transformers.js**, make it possible to run lightweight machine-learning models directly inside the browser.

The objective is to bridge these two environments:

**Local/browser-side perception + privacy protection + server-side reasoning**

while strictly enforcing data privacy at the client side.

Participants are required to build a **privacy-preserving vision agent running inside the browser**.

The system should contain a local **Vision Transformer (ViT) or equivalent computer vision model** that can understand/read the user's screen and make decisions based on the visual context.

If visual context needs to be sent to a server, the system must first sanitize sensitive/PII data using DOM tags or another appropriate mechanism before making the network request.

The system should dynamically detect and redact sensitive elements.

Examples include:

- Blurring faces
- Blacking out passwords
- Masking personally identifiable information
- Redacting other sensitive visual information

Only anonymized/unidentifiable information should be transmitted to the central server.

The server should understand the redaction scheme and process the sanitized context accordingly.

The server then processes the sanitized context and returns actionable commands to the browser agent, such as:

- Click the submit button
- Scroll down
- Fill a field
- Navigate to another page
- Perform another browser action

The local client then executes the required action.

The solution must balance:

- Inference latency
- Accuracy
- Privacy
- Client-side resource utilization

---

# 2. EXPECTED SOLUTION

The successful prototype should contain:

## Client-side / Browser Extension

The extension should work with popular browsers such as:

- Google Chrome
- Mozilla Firefox

It should include:

### Local Vision Processing

A client-side vision model running directly inside the browser, potentially using technologies such as WebGPU, that evaluates the current screen state.

### Privacy-Preserving Filter

A mechanism for sanitizing sensitive or personal visual information.

Possible approaches include:

- Local bounding-box redaction
- Semantic obfuscation
- Masking
- Blurring
- DOM-aware redaction
- Other privacy-preserving mechanisms

The privacy mechanism must be clearly demonstrated.

---

# 3. SERVER-SIDE COMPONENT

The system should transmit anonymized visual context to a centralized LLM/VLM.

The server should:

1. Receive sanitized visual/contextual information.
2. Understand the redaction scheme.
3. Interpret the screen.
4. Reason about the user's task.
5. Generate an appropriate action.
6. Return an actionable command to the local browser agent.

The browser agent should then execute the action.

Examples:

```text
Server → "Click Submit button"
Browser Agent → Finds Submit button → Clicks it
```

or:

```text
Server → "Scroll down"
Browser Agent → Executes scroll
```

Participants may use offline-deployable open-source/open-weight models on the server side, although cloud-hosted models can be used during SIH.

The prototype should demonstrate at least one complete **end-to-end browser task**.

---

# 4. OFFICIAL EVALUATION METRICS

The research and proposed solution MUST explicitly optimize for these SIH evaluation criteria:

| Evaluation Metric | Weight |
|---|---:|
| Accuracy of visual context from screen | 25% |
| Recall and precision for detection of sensitive/PII data | 20% |
| Precision of redaction | 20% |
| Client-side resource utilization | 20% |
| Overall end-to-end latency | 15% |

Do NOT ignore these metrics.

A major objective of your research should be:

**How can we design the architecture so that our team can score highly on all five metrics?**

---

# 5. IMPORTANT: FIRST STUDY THE UPLOADED PPT

I have uploaded the SIH PPT template.

Study it carefully and identify every section, requirement, and expectation.

The PPT contains these major sections:

1. Team Details
2. Idea / Approach / Proposed Solution
3. Novelty and Uniqueness
4. Technical Approach
5. Feasibility and Viability
6. Impact and Benefits
7. Research and References
8. Solution Summary

Your research MUST provide enough material to eventually fill every relevant section.

Pay particular attention to:

- Problem
- Proposed Solution
- USP / Differentiation
- Existing Solutions
- Novelty
- Technology Stack
- Process Flow
- System Architecture
- Feasibility
- Risks
- Mitigation strategies
- Social impact
- Economic impact
- Environmental impact
- References

Do not merely repeat the PPT template.

**Actually research and develop the content that should go inside each section.**

---

# 6. DO DEEP WEB RESEARCH

Perform serious and comprehensive web research.

Do NOT give me a generic AI-generated explanation based only on your existing knowledge.

Research:

- Academic papers
- Research publications
- GitHub repositories
- Official documentation
- Open-source projects
- Existing browser agents
- Vision-language models
- Browser automation systems
- Privacy-preserving AI systems
- On-device AI systems
- Browser-based ML inference
- WebGPU
- WebAssembly
- ONNX Runtime Web
- Transformers.js
- Vision Transformers
- Lightweight vision models
- OCR systems
- PII detection systems
- DOM-based privacy detection
- Screen understanding
- Multimodal agents
- Computer-use agents
- Browser-use agents
- Existing commercial solutions
- Existing open-source solutions
- Relevant benchmarks
- Relevant datasets
- Relevant security/privacy research

Prefer **primary and authoritative sources** wherever possible.

For technical technologies, prioritize:

- Official documentation
- Original research papers
- Official GitHub repositories
- Model documentation
- Benchmark papers

For existing products, research the actual product capabilities rather than assuming what they do.

For every important technical claim, provide a source/reference.

---

# 7. UNDERSTAND THE PROBLEM DEEPLY

Before proposing a solution, explain:

## What exactly is the problem?

Explain it in very simple Hinglish.

Then break it into:

### A. Core Problem

What is fundamentally difficult?

### B. Current Architecture Problem

Why do existing cloud-based AI/browser-agent systems create privacy concerns?

### C. On-device Constraint

Why can't we simply run a huge VLM/LLM completely on the user's machine?

Explain:

- RAM
- VRAM
- CPU
- GPU
- Mobile/laptop constraints
- Model size
- Inference latency
- Battery
- Browser limitations

### D. Privacy Problem

What sensitive information can appear on a user's screen?

For example:

- Passwords
- Email IDs
- Phone numbers
- Addresses
- Financial information
- Aadhaar/PAN-like identifiers
- Credit-card information
- Faces
- Private messages
- Medical information
- Authentication tokens
- API keys
- Company confidential information

Explain why blindly sending screenshots to a cloud VLM is dangerous.

### E. Agent Reliability Problem

Even if the server receives a screenshot, how can it reliably understand:

- Which element is clickable?
- Which text is important?
- What action should be taken?
- What coordinates correspond to the desired element?
- Whether the page has changed?

---

# 8. IDENTIFY ALL MAJOR PAIN POINTS

Create a detailed list of pain points.

For each pain point explain:

1. What is the problem?
2. Why does it happen?
3. Why is it difficult?
4. What impact does it have?
5. How can our architecture solve it?

At minimum investigate:

- Privacy leakage
- PII detection
- False positives
- False negatives
- Over-redaction
- Under-redaction
- Visual understanding
- OCR errors
- DOM-vs-pixel understanding
- Browser resource limitations
- Model size
- Inference latency
- WebGPU compatibility
- Browser compatibility
- Dynamic websites
- Shadow DOM
- Iframes
- Canvas elements
- Cross-origin restrictions
- Screenshots
- Coordinate mapping
- Action grounding
- Server communication
- Network latency
- Security
- Prompt injection
- Malicious webpages
- Data exfiltration
- Agent hallucination
- Incorrect actions

Do not limit yourself to this list. Identify additional problems through research.

---

# 9. DESIGN THE IDEAL SOLUTION

This is the MOST IMPORTANT part.

Develop a technically realistic architecture for solving the problem.

Think like a senior:

- AI engineer
- ML engineer
- Browser-extension engineer
- Privacy/security engineer
- System architect

Design the architecture from first principles.

Explain the complete pipeline:

```text
User
 ↓
Browser
 ↓
Browser Extension
 ↓
DOM + Accessibility Tree + Screenshot
 ↓
Local Privacy Detection
 ↓
Local Vision Model
 ↓
Sensitive Data Detection
 ↓
Redaction / Sanitization
 ↓
Sanitized Context
 ↓
Server
 ↓
LLM / VLM
 ↓
Action Planning
 ↓
Structured Action
 ↓
Browser Extension
 ↓
Action Validation
 ↓
Browser Execution
 ↓
User
```

But do NOT blindly use this architecture.

Improve it if your research suggests a better architecture.

---

# 10. VERY IMPORTANT: EXPLORE DOM + SCREEN + ACCESSIBILITY TREE

Research whether the system should rely only on screenshots.

Compare:

### Approach 1
Screenshot only

### Approach 2
DOM only

### Approach 3
Accessibility tree only

### Approach 4
DOM + screenshot

### Approach 5
DOM + accessibility tree + screenshot + local vision

Determine which architecture is best for this SIH problem.

Explain:

- Advantages
- Disadvantages
- Privacy
- Accuracy
- Latency
- Resource usage
- Robustness

Then recommend the best approach.

---

# 11. RESEARCH LOCAL VISION MODELS

Research lightweight models that could realistically run inside a browser.

Investigate options such as:

- MobileViT
- MobileNet
- EfficientNet
- YOLO-family lightweight models
- ViT variants
- DETR variants
- CLIP-like models
- OCR models
- Document understanding models
- UI-element detection models
- Small vision-language models

Do NOT assume ViT is automatically the best choice.

Compare models on:

- Model size
- Accuracy
- Inference speed
- Browser compatibility
- WebGPU support
- ONNX compatibility
- Memory consumption
- CPU fallback
- Quantization support
- Ease of implementation

Then recommend the best model(s) for our prototype.

---

# 12. RESEARCH PII / SENSITIVE DATA DETECTION

This is extremely important because SIH gives **20%** to PII detection and **20%** to redaction precision.

Research multiple approaches:

### DOM-based detection

For example:

- input type=password
- autocomplete attributes
- name attributes
- aria-label
- placeholder
- HTML semantics
- data attributes

### Regex-based detection

For:

- Email
- Phone number
- Credit card
- IDs
- URLs
- API keys
- Tokens

### NER-based detection

Investigate whether NLP models can detect PII.

### OCR-based detection

Use OCR to extract text from visual regions.

### Vision-based detection

Detect:

- Faces
- Documents
- Cards
- Sensitive objects

### Hybrid detection

Determine whether a combination of all of these is better.

Design a **multi-layer privacy engine**.

Explain exactly how it works.

---

# 13. DESIGN THE REDACTION ENGINE

Research how sensitive information should be redacted.

Compare:

- Black box
- Blur
- Pixelation
- Masking
- Semantic replacement
- Synthetic replacement
- Token replacement

For example:

```text
Mohd Afsar
↓
[PERSON_NAME]
```

or:

```text
9876543210
↓
[PHONE_NUMBER]
```

Determine which technique is best for:

- Privacy
- Model understanding
- Task completion
- Redaction precision

An important requirement is:

**The server should still understand the screen after redaction.**

Explain how we can preserve useful semantic information while removing sensitive information.

---

# 14. DESIGN A SMART PRIVACY PIPELINE

Research and propose something stronger than simply blurring the whole screen.

For example, investigate:

```text
Raw Screen
   ↓
Sensitive Region Detection
   ↓
Risk Classification
   ↓
Selective Redaction
   ↓
Semantic Preservation
   ↓
Sanitized Screen
   ↓
Server
```

Explore whether different sensitivity levels can be used:

### Level 0
Public information → send normally

### Level 1
Low sensitivity → semantic masking

### Level 2
PII → redaction

### Level 3
Highly sensitive → complete removal

Research whether such a system is feasible and useful.

---

# 15. SERVER-SIDE VLM / LLM RESEARCH

Research suitable server-side models.

Compare options such as:

- LLaVA-family models
- Qwen-VL / Qwen2.5-VL / newer suitable Qwen vision models
- InternVL
- MiniCPM-V
- Gemma multimodal models
- other suitable open-weight VLMs

Do not blindly recommend the latest model.

Evaluate based on:

- Accuracy
- Latency
- VRAM
- Model size
- Open-weight availability
- Deployment complexity
- Function/tool calling
- Structured output
- Screen understanding
- UI understanding
- Cost

Then recommend the best practical option for SIH.

---

# 16. ACTION REPRESENTATION

Research how the server should return actions.

Do NOT recommend returning free-form text such as:

> "Click the submit button."

Instead investigate structured action schemas such as:

```json
{
  "action": "click",
  "target": "submit_button",
  "confidence": 0.94
}
```

or:

```json
{
  "action": "type",
  "target": "email_field",
  "value": "[USER_EMAIL]"
}
```

Research:

- Function calling
- JSON schema
- Tool calling
- Action grounding
- Coordinate-based actions
- DOM-selector-based actions
- Accessibility-ID-based actions

Determine the most robust mechanism.

---

# 17. SECURITY RESEARCH

This is extremely important.

A browser agent can potentially perform dangerous actions.

Research threats such as:

- Prompt injection from webpages
- Malicious webpage content
- Indirect prompt injection
- Data exfiltration
- Fake buttons
- UI spoofing
- Clickjacking
- Malicious DOM
- Server compromise
- Model hallucination
- Unauthorized actions
- Credential theft

Then design safeguards.

For example:

```text
Server Action
 ↓
Local Policy Engine
 ↓
Risk Classification
 ↓
User Confirmation if Required
 ↓
Action Execution
```

Determine which actions should require confirmation.

---

# 18. BROWSER EXTENSION ARCHITECTURE

Research how to actually implement this as a Chrome/Firefox extension.

Investigate:

- Manifest V3
- Content scripts
- Background/service workers
- Extension APIs
- Permissions
- Screenshot APIs
- DOM access
- Message passing
- WebGPU
- WASM
- Offscreen documents
- Storage
- Security boundaries

Explain exactly what each component does.

---

# 19. TECHNOLOGY STACK

Create a recommended complete technology stack.

For EVERY technology explain:

1. What is it?
2. Why are we using it?
3. Where will it be used?
4. What alternative technologies exist?
5. Why did we choose this one?

Cover:

### Frontend / Extension

Possible technologies:

- JavaScript / TypeScript
- React if necessary
- Chrome Extension APIs
- Firefox Extension APIs

### Local AI

Possible technologies:

- WebGPU
- WebAssembly
- ONNX Runtime Web
- Transformers.js

### Computer Vision

- ViT / lightweight detector
- OCR
- UI element detection

### Privacy

- DOM parser
- Regex engine
- NER
- OCR
- Face detection
- Local redaction engine

### Backend

Possible:

- Python
- FastAPI
- Node.js

### AI Server

- VLM
- LLM
- vLLM / Ollama / other serving framework if appropriate

### Communication

- REST
- WebSocket
- WebRTC if relevant

### Deployment

- Docker
- GPU server
- Cloud/local server

Only recommend technologies after comparing alternatives.

---

# 20. END-TO-END WORKFLOW

Give at least **3 realistic browser-agent use cases**.

For example:

### Use Case 1
User fills a form.

### Use Case 2
User navigates a website and searches for information.

### Use Case 3
User completes a multi-step workflow.

For each use case show:

```text
User Intent
→
Screen Capture
→
Local Analysis
→
PII Detection
→
Redaction
→
Sanitized Context
→
Server Reasoning
→
Action Generation
→
Local Validation
→
Browser Action
→
Next Screen
```

Explain every step.

---

# 21. EXISTING SOLUTIONS / COMPETITOR RESEARCH

This is another VERY IMPORTANT part.

Find existing solutions that are related to:

- Browser agents
- Computer-use agents
- Browser automation
- Vision agents
- On-device AI
- Privacy-preserving AI
- Local browser AI
- Screen understanding
- Computer-use models

Investigate things such as:

- Browser-use
- OpenAI computer-use style systems
- Anthropic computer-use systems
- Google browser/agent research
- Microsoft browser agents
- Selenium-based AI agents
- Playwright-based AI agents
- UI-TARS-like approaches
- BrowserGym
- WebArena
- OSWorld
- AgentBench
- other relevant projects

Do not limit yourself to these examples.

---

# 22. COMPETITOR COMPARISON TABLE

Create a detailed table:

| Solution | Local Vision | Privacy Filter | Browser Agent | Server VLM | PII Redaction | On-device | Main Limitation |
|---|---|---|---|---|---|---|---|

Then clearly explain:

**What does every existing solution fail to solve?**

---

# 23. FIND OUR TRUE NOVELTY

This is extremely important.

Do NOT claim:

> "We use AI."

> "We use WebGPU."

> "We use a browser extension."

Those are NOT sufficient novelty.

Find genuine technical differentiation.

Investigate whether our novelty can be based on things like:

- Privacy-first perception architecture
- Local PII detection before network transmission
- DOM + visual hybrid perception
- Adaptive visual compression
- Semantic redaction
- Risk-aware redaction
- On-device lightweight perception
- Privacy-aware action planning
- Local validation of server actions
- Dynamic sensitivity classification
- Multi-stage perception
- Bandwidth-aware context transmission
- Adaptive local/cloud inference

But do not assume these are novel.

**Verify novelty through research.**

Then propose 2–4 strong, defensible USPs.

---

# 24. HOW TO MAKE OUR SOLUTION DIFFERENT

After researching existing solutions, answer:

### What exactly are we doing differently?

### Why can't existing solutions simply add the same feature?

### What technical mechanism creates our advantage?

### Why is our architecture better for this specific SIH problem?

### Why is it especially suitable for ISRO's requirement?

### Which SIH evaluation metrics will our innovation improve?

Map each USP to the evaluation metrics.

For example:

| Innovation | Accuracy | PII Recall | Redaction Precision | Resource Usage | Latency |
|---|---:|---:|---:|---:|---:|
| Hybrid DOM + Vision | ✓ | | ✓ | ✓ | ✓ |
| Local Privacy Engine | | ✓ | ✓ | | |
| Lightweight Model | | | | ✓ | ✓ |

Use realistic reasoning rather than arbitrary claims.

---

# 25. FEASIBILITY ANALYSIS

Determine whether the proposed solution is actually buildable by a student SIH team.

Analyze:

- Development complexity
- Hardware requirements
- Browser limitations
- Model availability
- Dataset requirements
- Training requirements
- Inference requirements
- Deployment complexity
- Time required
- Team skill requirements

Separate:

### MVP

What can realistically be built quickly?

### Strong Prototype

What should be demonstrated at SIH?

### Future Version

What can be added later?

---

# 26. RISKS AND MITIGATION

Create a detailed table:

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|

Cover at least:

- PII missed
- False positive redaction
- Excessive redaction
- Model too slow
- WebGPU unavailable
- Browser compatibility
- Server latency
- VLM hallucination
- Wrong browser action
- Prompt injection
- Privacy leakage
- High memory usage
- OCR errors
- Dynamic DOM
- Cross-origin limitations

---

# 27. BENCHMARKING STRATEGY

Design a proper evaluation framework specifically aligned with the SIH scoring.

Explain how we should measure:

## Metric 1 — Visual Accuracy (25%)

How do we measure whether the browser agent correctly understands the screen?

## Metric 2 — PII Precision & Recall (20%)

How do we create a test dataset and calculate:

- Precision
- Recall
- F1 score

## Metric 3 — Redaction Precision (20%)

How do we measure whether sensitive information was correctly redacted without destroying useful information?

## Metric 4 — Client Resource Utilization (20%)

Measure:

- CPU
- GPU
- RAM
- VRAM if relevant
- battery/power if possible
- model size

## Metric 5 — End-to-End Latency (15%)

Measure:

```text
Screen capture
+
Local inference
+
PII detection
+
Redaction
+
Network
+
Server inference
+
Action generation
+
Browser execution
```

Give a concrete benchmarking methodology.

---

# 28. DATASET RESEARCH

Since the problem statement allows open-source datasets, research useful datasets for:

- UI understanding
- Screen understanding
- OCR
- PII detection
- Face detection
- Document understanding
- Web interaction
- Browser agents

Investigate datasets such as:

- WebArena
- BrowserGym
- Mind2Web
- ScreenSpot
- OSWorld
- Rico
- PubLayNet
- FUNSD
- other relevant datasets

For every dataset explain:

- What it contains
- Why it is useful
- What task it can train/test
- License
- Whether it is suitable for our prototype

---

# 29. TRAINING VS INFERENCE

Determine whether we actually need to train models.

Analyze three possibilities:

### Option A
Use completely pre-trained models.

### Option B
Fine-tune existing models.

### Option C
Train a lightweight specialized model.

Tell us which approach is best for SIH.

Prefer a solution that is:

- Fast to implement
- Technically credible
- Demonstrable
- Easy to benchmark

---

# 30. PERFORMANCE OPTIMIZATION

Research practical optimization techniques such as:

- Quantization
- INT8
- INT4
- Model pruning
- Distillation
- Resolution reduction
- Region-of-interest inference
- Lazy inference
- Caching
- Frame skipping
- Event-driven inference
- Web Workers
- WebGPU acceleration
- WASM SIMD
- batching

Determine which optimizations are most useful.

---

# 31. IMPORTANT ARCHITECTURAL IDEA TO INVESTIGATE

Research whether we can avoid sending the entire screenshot whenever possible.

For example:

```text
Initial Screen
 ↓
Local Analysis
 ↓
Identify relevant regions
 ↓
Only send necessary sanitized context
 ↓
Server reasoning
```

Investigate whether we can transmit:

- DOM structure
- Accessibility tree
- Element bounding boxes
- OCR text
- UI labels
- Sanitized image crops
- Metadata

instead of full screenshots.

Determine whether this could improve:

- Privacy
- Latency
- Bandwidth
- Accuracy
- Resource utilization

---

# 32. DESIGN THE FINAL RECOMMENDED ARCHITECTURE

After doing all research, provide ONE final recommended architecture.

Do not leave me with 10 confusing alternatives.

Give me:

### Final Architecture

```text
[Architecture Diagram in text]
```

Then explain every component.

For example:

```text
Browser
│
├── Content Script
│
├── DOM/Accessibility Extractor
│
├── Screenshot Capture
│
├── Local Privacy Engine
│
├── Local Vision Model
│
├── Context Builder
│
├── Policy Engine
│
└── Action Executor
        │
        ▼
   Secure Gateway
        │
        ▼
   Server VLM/LLM
        │
        ▼
   Structured Action
        │
        ▼
   Local Validation
        │
        ▼
   Browser Action
```

Improve this architecture based on your research.

---

# 33. GIVE A CONCRETE IMPLEMENTATION PLAN

Give a step-by-step development roadmap.

For example:

### Phase 1
Browser extension skeleton

### Phase 2
DOM extraction

### Phase 3
Screenshot capture

### Phase 4
Local PII detection

### Phase 5
Redaction engine

### Phase 6
Local vision model

### Phase 7
Backend

### Phase 8
VLM integration

### Phase 9
Action generation

### Phase 10
Action execution

### Phase 11
Security

### Phase 12
Benchmarking

### Phase 13
Final demo

For every phase explain:

- What to build
- Why
- Expected output
- Dependencies
- Difficulty
- Potential problems

---

# 34. DEMO STRATEGY FOR SIH

Suggest the strongest possible live demonstration.

The demo should clearly show:

```text
Sensitive information exists on screen
        ↓
Local system detects it
        ↓
Sensitive information is redacted locally
        ↓
Only sanitized context leaves browser
        ↓
Server VLM understands the sanitized context
        ↓
Server returns structured action
        ↓
Browser executes action
```

Suggest 2–3 demo scenarios that would impress judges.

Also explain what NOT to demonstrate.

---

# 35. PPT CONTENT MAPPING

After completing the research, map your findings directly to my uploaded SIH PPT.

Create content recommendations for:

## Section 02 — Idea / Approach / Proposed Solution

- The Problem
- Our Solution
- What Makes It Different

## Section 03 — Novelty and Uniqueness

- Existing Solutions
- Their limitations
- What's genuinely new
- Why our approach closes the gap

## Section 04 — Technical Approach

- Architecture
- Process flow
- Technologies
- AI/ML
- Backend
- Deployment
- Prototype

## Section 05 — Feasibility and Viability

- Challenges
- Risks
- Mitigation

## Section 06 — Impact and Benefits

- Social
- Economic
- Environmental

## Section 07 — Research and References

Give the most credible references.

## Section 08 — Solution Summary

Give concise judge-friendly:

- Problem
- Proposed Solution
- Novelty / USP
- Feasibility
- Impact

Do NOT unnecessarily fill Team Details because I will provide team information separately.

---

# 36. IMPORTANT: SIMPLE HINGLISH

The final report MUST be written in **simple Hinglish**.

Use technical English terms where appropriate.

For example:

Instead of:

> "The proposed architecture leverages a privacy-preserving multimodal perception paradigm..."

Write:

> "Hum ek aisa system bana rahe hain jisme browser ke andar hi pehle screen ko analyze kiya jayega. Sensitive information server ko bhejne se pehle locally detect aur redact kar di jayegi."

Every technical term should be explained the first time it appears.

Example:

> **WebGPU:** WebGPU browser ka ek API hai jo browser ke andar GPU ki computing power use karne deta hai. Hum ise local AI model ko faster run karne ke liye use kar sakte hain.

Do this for ALL major technologies.

---

# 37. REPORT STRUCTURE

The final output should be a **very detailed research report**, structured approximately like this:

# SIH Problem 26171 — Deep Research Report

## 1. Executive Summary

## 2. Problem Statement Explained in Simple Hinglish

## 3. Why This Problem Matters

## 4. Core Pain Points

## 5. Existing Architecture / Current Approach

## 6. Limitations of Existing Systems

## 7. Proposed Solution

## 8. Detailed System Architecture

## 9. Browser Extension Architecture

## 10. Local Vision Pipeline

## 11. Privacy / PII Detection Pipeline

## 12. Redaction Engine

## 13. DOM + Screenshot + Accessibility Strategy

## 14. Server-Side VLM/LLM

## 15. Action Planning and Execution

## 16. Security Architecture

## 17. Recommended Technology Stack

## 18. Technology-by-Technology Explanation

## 19. Existing Solutions / Competitor Analysis

## 20. Research-Based Gap Analysis

## 21. Our Novelty / USP

## 22. Why Our Solution Is Different

## 23. Dataset Research

## 24. Training / Fine-Tuning Strategy

## 25. Performance Optimization

## 26. SIH Evaluation Strategy

## 27. Benchmarking Methodology

## 28. Feasibility Analysis

## 29. Risks and Mitigation

## 30. Development Roadmap

## 31. Recommended SIH Demo

## 32. PPT Section-by-Section Content

## 33. Final Recommended Architecture

## 34. Final Solution in Very Simple Hinglish

## 35. Research References

---

# 38. RESEARCH QUALITY REQUIREMENTS

Do NOT:

- Give generic textbook explanations.
- Invent research papers.
- Invent benchmarks.
- Invent product capabilities.
- Claim something is novel without checking existing work.
- Recommend technologies without explaining why.
- Say "AI will do it" without explaining the mechanism.
- Ignore browser limitations.
- Ignore privacy/security.
- Ignore the SIH scoring metrics.

DO:

- Research deeply.
- Compare alternatives.
- Cite credible sources.
- Clearly separate facts from assumptions.
- Identify technical trade-offs.
- Identify weaknesses in our proposed approach.
- Recommend practical solutions.
- Prioritize what can realistically be built for SIH.
- Keep the final explanation understandable to a student/team.
- Explain every important technical concept in simple Hinglish.

---

# 39. FINAL DECISION-MAKING REQUIREMENT

At the end, I want you to answer these questions VERY clearly:

### 1.
**Problem actually hai kya?**

### 2.
**Main pain points kya hain?**

### 3.
**Hum exactly kya bana rahe hain?**

### 4.
**System internally kaise kaam karega?**

### 5.
**Kaunsi technology kahan use hogi aur kyun?**

### 6.
**Existing solutions kya hain?**

### 7.
**Existing solutions mein kya problem hai?**

### 8.
**Hum unse better/different kya karenge?**

### 9.
**Hamari genuine novelty kya hai?**

### 10.
**SIH ke 5 evaluation metrics mein hum kaise score karenge?**

### 11.
**Prototype realistically kaise banega?**

### 12.
**Demo mein judges ko kya dikhayenge?**

### 13.
**Sabse difficult technical challenges kya hain?**

### 14.
**Un challenges ko practically kaise solve karenge?**

### 15.
**Agar tum hamari team ke technical architect hote, to final architecture kya choose karte?**

---

# 40. FINAL OUTPUT EXPECTATION

I don't want a short answer.

I want a **deep research document that can become the technical foundation of our entire SIH solution and PPT**.

Explain things from **basic → intermediate → advanced**.

Whenever you introduce a technical concept, explain:

**What is it → Why do we need it → How does it work → How will we use it → What alternative exists → Why are we choosing it.**

Use:

- Headings
- Subheadings
- Bullet points
- Tables
- Architecture diagrams in text
- Process flows
- Comparisons
- Examples
- Pros/cons
- Technical reasoning

Keep the language **simple Hinglish**, but do not oversimplify the technical content.

Most importantly:

> **Don't just research the problem. Research how we can actually WIN the problem statement by building a technically strong, privacy-preserving, low-latency browser vision agent that performs well on the exact SIH evaluation criteria.**

At the very end, provide a concise:

# "If I Were Building This for SIH — My Final Recommendation"

section containing the **single best architecture, technology stack, privacy strategy, AI models, USP, demo strategy, and implementation priority** that you recommend after completing all the research.