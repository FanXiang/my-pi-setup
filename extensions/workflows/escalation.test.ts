import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  appendAnswer,
  appendAssumption,
  appendFlag,
  blockerHash,
  blockerId,
  blockerPath,
  describeBlocker,
  normalizeAssumptionInput,
  normalizeBlockerInput,
  normalizeFlagInput,
  normalizeReplanInput,
  openBlockers,
  readAnswers,
  readAssumptions,
  readBlocker,
  readBlockers,
  readFlags,
  writeBlocker,
  writeReplan,
  type Blocker,
} from "./escalation.ts";

const CONTEXT = { stepLabel: "implement", phase: "Implement" };

function runDir() {
  return mkdtempSync(path.join(tmpdir(), "wf-escalation-"));
}

function blocker(overrides: Partial<Blocker> = {}): Blocker {
  const base = normalizeBlockerInput(
    {
      decision: "Which credential store should the deploy read?",
      evidence: "Both vault paths exist and neither is referenced in the repo.",
      recommendation: "Use the staging path; it matches the target account.",
      choices: ["staging path", "production path"],
    },
    CONTEXT,
  );
  return {
    ...base,
    id: blockerId(blockerHash(base), 0),
    openedAt: 1_000,
    notified: [],
    ...overrides,
  };
}

test("a blocker must hand over a decision, not a question", () => {
  const complete = {
    decision: "d",
    evidence: "e",
    recommendation: "r",
    choices: ["a", "b"],
  };
  assert.doesNotThrow(() => normalizeBlockerInput(complete, CONTEXT));

  // Every field exists because a person receiving this has to be able to act.
  for (const missing of ["decision", "evidence", "recommendation"] as const) {
    assert.throws(
      () => normalizeBlockerInput({ ...complete, [missing]: "  " }, CONTEXT),
      new RegExp(missing),
      `${missing} must be required`,
    );
  }
  assert.throws(
    () => normalizeBlockerInput({ ...complete, choices: [] }, CONTEXT),
    /non-empty `choices`/,
  );
  assert.throws(
    () => normalizeBlockerInput({ ...complete, choices: ["ok", " "] }, CONTEXT),
    /choice 1/,
  );
  assert.throws(
    () => normalizeBlockerInput("just a string", CONTEXT),
    /expects an object/,
  );
});

test("an assumption defaults to irreversible", () => {
  const assumption = normalizeAssumptionInput(
    { question: "Which timezone?", assumption: "UTC" },
    CONTEXT,
  );
  assert.equal(
    assumption.reversible,
    false,
    "an assumption wrongly marked safe is the one that gets skipped",
  );
  assert.equal(assumption.stepLabel, "implement");
  assert.equal(assumption.phase, "Implement");
  assert.equal(
    normalizeAssumptionInput(
      { question: "q", assumption: "a", reversible: true },
      CONTEXT,
    ).reversible,
    true,
  );
  assert.throws(
    () => normalizeAssumptionInput({ question: "q" }, CONTEXT),
    /`assumption`/,
  );
});

test("a flag accepts a bare note", () => {
  assert.equal(
    normalizeFlagInput("watch the retry loop", CONTEXT).note,
    "watch the retry loop",
  );
  assert.equal(
    normalizeFlagInput({ note: "n", evidence: "e" }, CONTEXT).evidence,
    "e",
  );
  assert.throws(() => normalizeFlagInput({}, CONTEXT), /`note`/);
});

test("a replan keeps its clarifications and drops empty ones", () => {
  const replan = normalizeReplanInput({
    reason: "The spec contradicts itself on retry behaviour.",
    suggestedClarifications: ["Which wins?", "   ", ""],
  });
  assert.deepEqual(replan.suggestedClarifications, ["Which wins?"]);
  assert.equal(normalizeReplanInput("plain reason").reason, "plain reason");
  assert.throws(() => normalizeReplanInput({}), /`reason`/);
});

test("the same block resolves to the same id, a different one does not", () => {
  const base = normalizeBlockerInput(
    { decision: "d", evidence: "e", recommendation: "r", choices: ["a", "b"] },
    CONTEXT,
  );
  assert.equal(blockerHash(base), blockerHash({ ...base }));
  assert.notEqual(
    blockerHash(base),
    blockerHash({ ...base, decision: "other" }),
  );
  assert.notEqual(
    blockerHash(base),
    blockerHash({ ...base, choices: ["a", "c"] }),
  );
  assert.notEqual(
    blockerHash(base),
    blockerHash({ ...base, stepLabel: "review" }),
  );

  // Occurrence separates two identical blocks raised in one run.
  assert.notEqual(
    blockerId(blockerHash(base), 0),
    blockerId(blockerHash(base), 1),
  );
});

test("assumptions and flags round-trip through their files", () => {
  const dir = runDir();
  appendAssumption(
    dir,
    normalizeAssumptionInput({ question: "q1", assumption: "a1" }, CONTEXT),
  );
  appendAssumption(
    dir,
    normalizeAssumptionInput(
      { question: "q2", assumption: "a2", reversible: true },
      CONTEXT,
    ),
  );
  appendFlag(dir, normalizeFlagInput("f1", CONTEXT));

  assert.deepEqual(
    readAssumptions(dir).map((item) => [item.question, item.reversible]),
    [
      ["q1", false],
      ["q2", true],
    ],
  );
  assert.deepEqual(
    readFlags(dir).map((item) => item.note),
    ["f1"],
  );
});

test("a blocker round-trips as a single-line JSON file", () => {
  const dir = runDir();
  const opened = blocker();
  writeBlocker(dir, opened);

  const raw = readFileSync(blockerPath(dir, opened.id), "utf8");
  assert.equal(raw.includes("\n"), false, "a blocker file stays one line");
  assert.deepEqual(readBlocker(dir, opened.id), opened);
  assert.deepEqual(readBlockers(dir), [opened]);
  assert.equal(readBlocker(dir, "missing"), undefined);
  assert.deepEqual(readBlockers(runDir()), []);
});

test("answering a blocker closes it, and a later answer wins", () => {
  const dir = runDir();
  const opened = blocker();
  writeBlocker(dir, opened);
  assert.deepEqual(
    openBlockers(dir).map((item) => item.id),
    [opened.id],
  );

  appendAnswer(dir, { id: opened.id, choice: "staging path", answeredAt: 1 });
  assert.deepEqual(openBlockers(dir), [], "an answered blocker is not open");

  appendAnswer(dir, {
    id: opened.id,
    choice: "production path",
    note: "changed my mind",
    answeredAt: 2,
  });
  const answers = readAnswers(dir);
  assert.equal(answers.size, 1);
  assert.equal(answers.get(opened.id)?.choice, "production path");
  assert.equal(answers.get(opened.id)?.note, "changed my mind");
});

test("two blockers stay independently answerable", () => {
  const dir = runDir();
  const first = blocker();
  const second = blocker({
    id: blockerId(blockerHash(first), 1),
    openedAt: 2_000,
  });
  writeBlocker(dir, first);
  writeBlocker(dir, second);

  appendAnswer(dir, { id: first.id, choice: "staging path", answeredAt: 1 });
  assert.deepEqual(
    openBlockers(dir).map((item) => item.id),
    [second.id],
  );
});

test("the blocker text gives a person everything needed to answer", () => {
  const text = describeBlocker(blocker(), "wf_abc123");
  for (const expected of [
    "wf_abc123",
    "Which credential store",
    "Evidence:",
    "Recommendation:",
    "1. staging path",
    "2. production path",
    "workflow_answer",
  ]) {
    assert.ok(text.includes(expected), `missing ${expected}`);
  }
});

test("a replan record is written where the reader will look", () => {
  const dir = runDir();
  writeReplan(dir, normalizeReplanInput({ reason: "spec contradicts itself" }));
  const raw = readFileSync(path.join(dir, "replan.json"), "utf8");
  assert.match(raw, /spec contradicts itself/);
});
