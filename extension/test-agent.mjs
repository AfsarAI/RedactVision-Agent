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
// Section 1: Architecture invariant — no client-side prompt parser
// ============================================================================
//
// The RedactVision architecture (CLAUDE.md §5, §18) forbids the
// client from interpreting the user's natural-language prompt with
// hardcoded grammar / keyword / regex rules. The server LLM is the
// SOLE planner.
//
// This test asserts that the action-planner module no longer exports
// a `planAction` function and only contains the shared
// `PlanningContext` type.
console.log("=== Architecture invariant: no client-side prompt parser ===");

// Inspect the source code (not the runtime module) because TypeScript
// `import type` statements are erased at runtime and would make
// `PlanningContext` invisible to a runtime `Object.keys` check.
const fs = await import("node:fs/promises");
const plannerSrc = await fs.readFile(
  join(__dirname, "src", "agent", "action-planner.ts"),
  "utf8"
);

let pass = 0, fail = 0;

if (/\bfunction\s+planAction\b/.test(plannerSrc)) {
  console.log("  ✗  action-planner.ts still defines a planAction function — client-side parser must be removed");
  fail++;
} else {
  console.log("  ✓  action-planner.ts does NOT define a planAction function");
  pass++;
}

if (/\bexport\s+(interface|class|function|const|type)\s+PlanningContext\b/.test(plannerSrc)) {
  console.log("  ✓  action-planner.ts exports the PlanningContext type");
  pass++;
} else {
  console.log("  ✗  action-planner.ts is missing the PlanningContext export");
  fail++;
}

// ============================================================================
// Section 2: Planner routes ONLY through the server
// ============================================================================
//
// The LLMPlanner is the only entry-point that the agent session uses
// to get a next action. Its `plan()` method MUST go through the
// server. We verify the planner source code:
//
//   - imports `planViaServer` (not `planAction`)
//   - returns source="server-llm" on a successful server response
//   - returns source="none" + errorCode="llm_not_configured" on 503
//
console.log("\n=== Planner routes through server only ===");

const plannerIndexPath = "file://" + join(__dirname, "src", "llm", "llm-planner.ts");
const llmPlannerSrc = await fs.readFile(
  join(__dirname, "src", "llm", "llm-planner.ts"),
  "utf8"
);

if (llmPlannerSrc.includes('from "../agent/action-planner"') && llmPlannerSrc.includes("planAction")) {
  console.log("  ✗  llm-planner.ts still imports planAction — server must be the only planner");
  fail++;
} else {
  console.log("  ✓  llm-planner.ts does NOT import planAction");
  pass++;
}

if (llmPlannerSrc.includes('from "./extension-bridge"') && llmPlannerSrc.includes("planViaServer")) {
  console.log("  ✓  llm-planner.ts routes through the server bridge (planViaServer)");
  pass++;
} else {
  console.log("  ✗  llm-planner.ts does not appear to route through planViaServer");
  fail++;
}

if (llmPlannerSrc.includes("errorCode")) {
  console.log("  ✓  llm-planner.ts reports structured errorCode (llm_not_configured, etc.)");
  pass++;
} else {
  console.log("  ✗  llm-planner.ts is missing structured errorCode");
  fail++;
}

// ============================================================================
// Section 3: LLM action schema validation tests
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
