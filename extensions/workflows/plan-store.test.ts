import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { normalizePlanInput, planHash, type Plan } from "./plan.ts";
import {
  listPlans,
  planPath,
  plansDir,
  readPlan,
  writePlan,
} from "./plan-store.ts";

function workflowsDir() {
  return mkdtempSync(path.join(tmpdir(), "wf-plan-store-"));
}

function plan(overrides: Record<string, unknown> = {}): Plan {
  return normalizePlanInput({
    workItemId: "wi-1",
    task: { title: "T", statement: "Do the thing.", cwd: "/repo" },
    provider: { id: "p", version: "1", catalogHash: "h" },
    budget: { agentCalls: 4, concurrency: 2 },
    policy: { blockable: false, maxEscalation: 2, onGateFail: "escalate" },
    steps: [
      {
        id: "s1",
        kind: "serial",
        mode: "HITL",
        procedure: "spec",
        label: "Spec",
        blockedBy: [],
        brief: "Write it.",
        escalation: 1,
        effects: "readonly",
      },
    ],
    ...overrides,
  });
}

test("a plan round-trips through disk unchanged", () => {
  const dir = workflowsDir();
  const written = plan();
  writePlan(dir, written);
  const read = readPlan(dir, written.planId);
  assert.deepEqual(read, written);
  // The hash is what approval binds to, so a round-trip that changed it would
  // silently invalidate every approval.
  assert.equal(planHash(read!), planHash(written));
});

test("plans land in one directory, not nested under themselves", () => {
  const dir = workflowsDir();
  const written = plan();
  const file = writePlan(dir, written);
  assert.equal(file, path.join(dir, "plans", `${written.planId}.json`));
  assert.equal(existsSync(file), true);
  assert.equal(planPath(dir, written.planId), file);
  assert.equal(plansDir(dir), path.join(dir, "plans"));
});

test("a stored plan is a readable document", () => {
  // It exists to be reviewed before approval; unreadable JSON would defeat it.
  const dir = workflowsDir();
  const written = plan();
  const file = writePlan(dir, written);
  const raw = readFileSync(file, "utf8");
  assert.match(raw, /\n  "planId"/);
  assert.equal(raw.endsWith("\n"), true);
});

test("an approval survives the round trip", () => {
  const dir = workflowsDir();
  const written = plan();
  written.approval = {
    planHash: planHash(written),
    approvedAt: 1_700_000_000_000,
    approvedBy: "user",
  };
  writePlan(dir, written);
  assert.deepEqual(readPlan(dir, written.planId)?.approval, written.approval);
});

test("reading a missing or corrupt plan yields nothing, not a throw", () => {
  const dir = workflowsDir();
  assert.equal(readPlan(dir, "pl_nothere"), undefined);
  writePlan(dir, plan());
  writeFileSync(path.join(plansDir(dir), "pl_broken.json"), "{ not json");
  assert.equal(readPlan(dir, "pl_broken"), undefined);
});

test("a hand-edited plan is re-validated on read, not trusted", () => {
  const dir = workflowsDir();
  const written = plan();
  writePlan(dir, written);
  writeFileSync(
    planPath(dir, written.planId),
    JSON.stringify({
      ...written,
      steps: [{ ...written.steps[0], kind: "nonsense" }],
    }),
  );
  assert.equal(readPlan(dir, written.planId), undefined);
});

test("listing skips the file that no longer parses", () => {
  const dir = workflowsDir();
  const a = plan();
  const b = plan();
  writePlan(dir, a);
  writePlan(dir, b);
  writeFileSync(path.join(plansDir(dir), "pl_broken.json"), "{ not json");
  writeFileSync(path.join(plansDir(dir), "notes.txt"), "ignored");
  const listed = listPlans(dir)
    .map((entry) => entry.planId)
    .sort();
  assert.deepEqual(listed, [a.planId, b.planId].sort());
});

test("listing an empty or absent directory is empty, not an error", () => {
  assert.deepEqual(listPlans(workflowsDir()), []);
  assert.deepEqual(listPlans(path.join(workflowsDir(), "nope")), []);
});
