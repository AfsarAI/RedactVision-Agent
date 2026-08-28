# RedactVision Agent

Privacy-preserving on-device visual web agent for SIH Problem Statement 26171.

## Team

ByteForce

## Problem Statement

SIH26171 — On-device Visual Perception for Light-weight Browser Agents

## Project

Product Name: RedactVision Agent

## Current Prototype

The prototype currently implements:

- Chrome Extension using Manifest V3
- Local DOM extraction
- On-device privacy firewall
- Sensitive data detection
- Semantic token replacement
- Local token mapping
- Sanitized DOM generation

## Architecture

Webpage
→ DOM Extraction
→ On-Device Privacy Firewall
→ Semantic Tokenization
→ Secure Server
→ VLM Reasoning
→ Structured Action
→ Local Validation
→ Browser Execution

## Development

### Extension

```bash
cd extension
npm install
npm run build