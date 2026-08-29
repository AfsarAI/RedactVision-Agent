/**
 * RedactVision Agent - Smoke test for planner logic + LLM schema
 *
 * Run: cd extension && node --experimental-strip-types test-agent.mjs
 *  (Node 22+ has --experimental-strip-types for inline TS)
 *  Or: npx tsx test-agent.mjs
 */

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ============================================================================
// Section 1: Deterministic planner tests
// ============================================================================
console.log("=== Deterministic planner ===");

const plannerPath = "file://" + join(__dirname, "src", "agent", "action-planner.ts");
const { planAction } = await import(plannerPath);

const ctx = {
  sanitizedDOM: {
    url: "http://localhost:8000/",
    title: "Test Page",
    elements: [
      { tag: "input", id: "full-name", name: "fullName", value: "[PERSON_01]", selector: "#full-name" },
      { tag: "input", id: "email", name: "email", value: "[EMAIL_01]", selector: "#email" },
      { tag: "input", id: "phone", name: "phone", value: "[PHONE_01]", selector: "#phone" },
      { tag: "input", id: "password", name: "password", value: "[PASSWORD_01]", selector: "#password" },
      { tag: "select", id: "country", name: "country", value: "", selector: "#country" },
      { tag: "button", id: "submit-btn", text: "Submit Form", selector: "#submit-btn" },
      { tag: "button", id: "cancel-btn", text: "Cancel", selector: "#cancel-btn" },
    ],
  },
};

const plannerCases = [
  ["scroll down", (o) => o?.action === "scroll" && o.direction === "down"],
  ["scroll to the bottom", (o) => o?.action === "scroll" && o.direction === "down"],
  ["scroll up 300", (o) => o?.action === "scroll" && o.direction === "up" && o.amount === 300],
  ["click submit", (o) => o?.action === "click" && o.target === "#submit-btn"],
  ["click cancel", (o) => o?.action === "click" && o.target === "#cancel-btn"],
  ["click submit form", (o) => o?.action === "click" && o.target === "#submit-btn"],
  ["fill the email", (o) => o?.action === "type" && o.target === "#email"],
  ["fill the name", (o) => o?.action === "type" && o.target === "#full-name"],
  ["select india", (o) => o?.action === "select" && o.target === "#country"],
  ["wait", (o) => o?.action === "wait"],
  ["nonsense foo bar", (o) => o === null],
];

let pass = 0, fail = 0;
for (const [prompt, check] of plannerCases) {
  const out = planAction(prompt, ctx);
  const ok = check(out);
  const tag = out
    ? `${out.action}${out.target ? " " + out.target : ""}${out.direction ? " " + out.direction : ""}${out.value ? " " + out.value : ""}`
    : "null";
  if (ok) {
    console.log(`  ✓  "${prompt}"  →  ${tag}`);
    pass++;
  } else {
    console.log(`  ✗  "${prompt}"  expected something matching, got: ${tag}`);
    fail++;
  }
}

// ============================================================================
// Section 2: LLM action schema validation tests
// ============================================================================
console.log("\n=== LLM action schema ===");

const schemaPath = "file://" + join(__dirname, "src", "llm", "action-schema.ts");
const { validateLLMAction, toExecutorAction } = await import(schemaPath);

const schemaCases = [
  {
    name: "valid click",
    input: { action: "click", target: "#x", confidence: 0.9 },
    expect: "ok",
  },
  {
    name: "valid type with literal value",
    input: { action: "type", target: "#name", value: "Afsar", confidence: 0.95 },
    expect: "ok",
  },
  {
    name: "valid type with token value",
    input: { action: "type", target: "#email", value: "[EMAIL_01]", confidence: 0.95 },
    expect: "ok",
  },
  {
    name: "valid done action",
    input: { action: "done", confidence: 0.99 },
    expect: "ok",
  },
  {
    name: "invalid: click without target",
    input: { action: "click", confidence: 0.9 },
    expect: "fail",
  },
  {
    name: "invalid: type without value",
    input: { action: "type", target: "#x", confidence: 0.9 },
    expect: "fail",
  },
  {
    name: "invalid: bad confidence",
    input: { action: "click", target: "#x", confidence: 1.5 },
    expect: "fail",
  },
  {
    name: "invalid: unknown action",
    input: { action: "frob", confidence: 0.5 },
    expect: "fail",
  },
  {
    name: "valid scroll with direction+amount",
    input: { action: "scroll", direction: "down", amount: 700, confidence: 0.95 },
    expect: "ok",
  },
];

for (const c of schemaCases) {
  const r = validateLLMAction(c.input);
  const ok = c.expect === "ok" ? r.ok : !r.ok;
  if (ok) {
    console.log(`  ✓  ${c.name}`);
    pass++;
  } else {
    console.log(`  ✗  ${c.name}  expected=${c.expect} got=${r.ok ? "ok" : "fail (" + r.reason + ")"}`);
    fail++;
  }
}

// ============================================================================
// Section 3: LLM → executor conversion tests
// ============================================================================
console.log("\n=== LLM → executor conversion ===");

const convCases = [
  {
    name: "LLM click → executor click with target",
    llm: { action: "click", target: "#submit", confidence: 0.95 },
    check: (a) => a?.action === "click" && a.target === "#submit" && a.confidence === 0.95,
  },
  {
    name: "LLM done → null (signals loop exit)",
    llm: { action: "done", confidence: 0.99 },
    check: (a) => a === null,
  },
  {
    name: "LLM type with literal value → executor preserves it",
    llm: { action: "type", target: "#name", value: "Afsar", confidence: 0.95 },
    check: (a) => a?.action === "type" && a.value === "Afsar",
  },
  {
    name: "LLM scroll with amount → executor preserves",
    llm: { action: "scroll", direction: "up", amount: 300, confidence: 0.9 },
    check: (a) => a?.action === "scroll" && a.direction === "up" && a.amount === 300,
  },
];

for (const c of convCases) {
  const out = toExecutorAction(c.llm);
  const ok = c.check(out);
  if (ok) {
    console.log(`  ✓  ${c.name}`);
    pass++;
  } else {
    console.log(`  ✗  ${c.name}  got=${JSON.stringify(out)}`);
    fail++;
  }
}

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
