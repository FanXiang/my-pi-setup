import assert from "node:assert/strict";
import { test } from "node:test";
import {
  describeGateFailures,
  evaluateGate,
  evaluatePredicate,
  resolvePath,
} from "./gate.ts";
import type { Gate, Predicate } from "./plan.ts";

function check(payload: unknown, predicate: Predicate) {
  return evaluatePredicate(payload, predicate);
}

function passes(payload: unknown, predicate: Predicate) {
  assert.equal(
    check(payload, predicate),
    undefined,
    `expected ${predicate.op} on ${predicate.path} to hold`,
  );
}

function fails(payload: unknown, predicate: Predicate, pattern?: RegExp) {
  const failure = check(payload, predicate);
  assert.ok(failure, `expected ${predicate.op} on ${predicate.path} to fail`);
  if (pattern) assert.match(failure.message, pattern);
  return failure;
}

test("resolvePath walks objects and indexes arrays", () => {
  const payload = { risks: [{ severity: "high" }, { severity: "low" }] };
  assert.deepEqual(resolvePath(payload, "risks.1.severity"), {
    found: true,
    value: "low",
  });
  assert.deepEqual(resolvePath(payload, "risks.9"), {
    found: false,
    value: undefined,
  });
  assert.deepEqual(resolvePath(payload, "risks.name"), {
    found: false,
    value: undefined,
  });
  assert.deepEqual(resolvePath(payload, "nothing.here"), {
    found: false,
    value: undefined,
  });
});

test("resolvePath distinguishes a present null from an absent field", () => {
  assert.deepEqual(resolvePath({ a: null }, "a"), { found: true, value: null });
  assert.deepEqual(resolvePath({}, "a"), { found: false, value: undefined });
});

test("resolvePath does not read inherited properties", () => {
  assert.deepEqual(resolvePath({}, "toString"), {
    found: false,
    value: undefined,
  });
});

test("exists means present and not null", () => {
  passes({ a: 0 }, { path: "a", op: "exists" });
  passes({ a: false }, { path: "a", op: "exists" });
  fails({ a: null }, { path: "a", op: "exists" }, /a is missing/);
  fails({}, { path: "a", op: "exists" });
});

test("nonEmpty treats whitespace as nothing", () => {
  passes({ a: "text" }, { path: "a", op: "nonEmpty" });
  fails({ a: "" }, { path: "a", op: "nonEmpty" });
  fails({ a: "   \n" }, { path: "a", op: "nonEmpty" }, /is empty/);
  passes({ a: [1] }, { path: "a", op: "nonEmpty" });
  fails({ a: [] }, { path: "a", op: "nonEmpty" });
  passes({ a: { k: 1 } }, { path: "a", op: "nonEmpty" });
  fails({ a: {} }, { path: "a", op: "nonEmpty" });
});

test("nonEmpty counts zero and false as answers", () => {
  // A field whose legitimate value is 0 would otherwise be unassertable.
  passes({ a: 0 }, { path: "a", op: "nonEmpty" });
  passes({ a: false }, { path: "a", op: "nonEmpty" });
});

test("minLength cannot be satisfied with padding", () => {
  passes({ a: "abcd" }, { path: "a", op: "minLength", value: 4 });
  fails({ a: "  a  " }, { path: "a", op: "minLength", value: 4 }, /got 1/);
  passes({ a: [1, 2] }, { path: "a", op: "minLength", value: 2 });
  fails(
    { a: [1] },
    { path: "a", op: "minLength", value: 2 },
    /needs at least 2 entries, got 1/,
  );
});

test("the length operators say so when there is no length", () => {
  fails(
    { a: 42 },
    { path: "a", op: "minLength", value: 1 },
    /no length to measure/,
  );
  fails({}, { path: "a", op: "maxLength", value: 1 }, /no length to measure/);
});

test("maxLength holds an upper bound", () => {
  passes({ a: "abc" }, { path: "a", op: "maxLength", value: 3 });
  fails(
    { a: "abcd" },
    { path: "a", op: "maxLength", value: 3 },
    /allows at most 3 characters, got 4/,
  );
});

test("eq and ne compare by value, not by key order", () => {
  passes({ a: { x: 1, y: 2 } }, { path: "a", op: "eq", value: { y: 2, x: 1 } });
  fails({ a: { x: 1 } }, { path: "a", op: "ne", value: { x: 1 } });
  passes({ a: "ready" }, { path: "a", op: "eq", value: "ready" });
  fails(
    { a: "draft" },
    { path: "a", op: "eq", value: "ready" },
    /must equal "ready", got "draft"/,
  );
});

test("matches applies a regular expression to a string", () => {
  passes({ a: "PI-1234" }, { path: "a", op: "matches", value: "^PI-\\d+$" });
  fails(
    { a: "nope" },
    { path: "a", op: "matches", value: "^PI-\\d+$" },
    /does not match/,
  );
  fails(
    { a: 1234 },
    { path: "a", op: "matches", value: "^\\d+$" },
    /must be a string to match against/,
  );
});

test("everyNonEmpty rejects the list with one blank in it", () => {
  passes({ a: ["one", "two"] }, { path: "a", op: "everyNonEmpty" });
  fails(
    { a: ["one", "  "] },
    { path: "a", op: "everyNonEmpty" },
    /a\[1\] is empty/,
  );
  fails({ a: [] }, { path: "a", op: "everyNonEmpty" }, /empty array/);
  fails({ a: "one" }, { path: "a", op: "everyNonEmpty" }, /must be an array/);
});

test("the plan author's message wins over the generated one", () => {
  // The person who wrote the gate knows what the field is for; a sentence
  // about minLength is a worse repair instruction than theirs.
  const failure = fails(
    { criteria: [] },
    {
      path: "criteria",
      op: "nonEmpty",
      message: "List at least one acceptance criterion, in Given/When/Then.",
    },
  );
  assert.equal(
    failure.message,
    "List at least one acceptance criterion, in Given/When/Then.",
  );
});

test("a gate reports every failure at once", () => {
  // One repair round should fix everything, not reveal the next problem.
  const gate: Gate = {
    schema: { type: "object" },
    predicates: [
      { path: "summary", op: "nonEmpty" },
      { path: "criteria", op: "everyNonEmpty" },
      { path: "ticket", op: "matches", value: "^PI-\\d+$" },
    ],
  };
  const result = evaluateGate(
    { summary: "", criteria: ["ok", ""], ticket: "none" },
    gate,
  );
  assert.equal(result.ok, false);
  assert.equal(result.failures.length, 3);
  assert.equal(result.passed, 0);
  assert.deepEqual(
    result.failures.map((failure) => failure.path),
    ["summary", "criteria", "ticket"],
  );
});

test("a satisfied gate passes and counts its predicates", () => {
  const gate: Gate = {
    schema: { type: "object" },
    predicates: [
      { path: "summary", op: "nonEmpty" },
      { path: "criteria", op: "minLength", value: 2 },
    ],
  };
  const result = evaluateGate({ summary: "Done.", criteria: ["a", "b"] }, gate);
  assert.deepEqual(result, { ok: true, failures: [], passed: 2 });
});

test("a gate with no predicates is vacuously satisfied", () => {
  // The schema already constrained the shape; a gate may add nothing further.
  const result = evaluateGate({}, { schema: {}, predicates: [] });
  assert.equal(result.ok, true);
});

test("the repair instruction lists what to fix", () => {
  const gate: Gate = {
    schema: {},
    predicates: [
      { path: "summary", op: "nonEmpty", message: "Summarise the change." },
      { path: "tests", op: "nonEmpty" },
    ],
  };
  const text = describeGateFailures(evaluateGate({}, gate).failures);
  assert.match(text, /did not pass 2 check\(s\)/);
  assert.match(text, /- Summarise the change\./);
  assert.match(text, /- tests is empty/);
  assert.match(text, /Produce a corrected structured result/);
  assert.equal(describeGateFailures([]), "");
});
