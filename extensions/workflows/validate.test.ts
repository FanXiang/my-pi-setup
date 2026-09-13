import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { normalizePlanInput, planHash, type Plan } from "./plan.ts";
import type { MethodologyProvider, ProcedureMeta } from "./provider.ts";
import {
  describeValidationReport,
  validatePlan,
  type RuleId,
  type ValidationReport,
} from "./validate.ts";

const PROCEDURES: ProcedureMeta[] = [
  {
    id: "spec",
    kind: "workflow",
    phases: ["planning"],
    allowedNext: ["implement"],
    requires: [],
    discloses: [],
    standalone: false,
  },
  {
    id: "implement",
    kind: "workflow",
    phases: ["implement"],
    // Self-edge: one implement step routinely follows another.
    allowedNext: ["implement", "review"],
    requires: [],
    discloses: [],
    standalone: false,
  },
  {
    id: "review",
    kind: "workflow",
    phases: ["review"],
    allowedNext: ["handoff"],
    requires: [],
    discloses: [],
    standalone: false,
  },
  {
    id: "handoff",
    kind: "workflow",
    phases: ["handoff"],
    allowedNext: [],
    requires: [],
    discloses: [],
    standalone: true,
    // A handoff must never stop and wait for a person; V5 enforces it.
    maxEscalation: 1,
  },
];

const provider: MethodologyProvider = {
  id: "test-provider",
  version: "1.0.0",
  catalogHash: "cafe1234",
  listProcedures: () => PROCEDURES,
  loadBrief: async () => "brief",
  gateFor: () => undefined,
  validateEdge: (from, to) =>
    PROCEDURES.find((procedure) => procedure.id === from)?.allowedNext.includes(
      to,
    ) ?? false,
};

/** A repo whose package.json declares the scripts a gate may verify with. */
const REPO = mkdtempSync(path.join(tmpdir(), "wf-plan-repo-"));
writeFileSync(
  path.join(REPO, "package.json"),
  JSON.stringify({ scripts: { test: "node --test", lint: "eslint ." } }),
);

const gate = () => ({
  schema: { type: "object", properties: { summary: { type: "string" } } },
  predicates: [{ path: "summary", op: "nonEmpty" }],
});

type Draft = Record<string, any>;

function draft(): Draft {
  return {
    version: 2,
    planId: "pl_abc123",
    workItemId: "wi-42",
    task: {
      title: "Add a retry budget",
      statement: "Give each workflow step a retry budget that survives resume.",
      cwd: REPO,
      branch: "feature/retry-budget",
    },
    provider: {
      id: "test-provider",
      version: "1.0.0",
      catalogHash: "cafe1234",
    },
    budget: { agentCalls: 8, concurrency: 2 },
    policy: {
      blockable: true,
      maxEscalation: 3,
      onGateFail: "repair-once",
      notify: [{ channel: "file" }],
    },
    steps: [
      {
        id: "s1-spec",
        kind: "serial",
        mode: "AFK",
        procedure: "spec",
        label: "Write the spec",
        blockedBy: [],
        brief: "Produce a spec for the retry budget.",
        gate: gate(),
        escalation: 1,
        effects: "readonly",
      },
      {
        id: "s2-implement",
        kind: "serial",
        mode: "AFK",
        procedure: "implement",
        label: "Implement it",
        blockedBy: ["s1-spec"],
        brief: "Implement the spec.",
        gate: { ...gate(), verify: { script: "test" } },
        escalation: 2,
        effects: "repo",
        budget: { agentCalls: 3 },
      },
      {
        id: "s3-review",
        kind: "fanout",
        mode: "AFK",
        procedure: "review",
        label: "Review on two axes",
        blockedBy: ["s2-implement"],
        brief: "Review the change.",
        gate: gate(),
        escalation: 1,
        effects: "readonly",
        budget: { agentCalls: 2 },
        fanout: {
          items: [
            { key: "correctness", brief: "Review for correctness." },
            { key: "simplicity", brief: "Review for simplicity." },
          ],
        },
      },
    ],
  };
}

/**
 * Build a plan from the legal baseline, optionally broken in exactly one way.
 *
 * Approval is applied last so that a fixture which mutates the plan does not
 * also trip V9 by accident - every rule below should fail on its own merits,
 * not because the fixture disturbed something else.
 */
function build(mutate: (plan: Draft) => void = () => {}): Plan {
  const raw = draft();
  mutate(raw);
  const plan = normalizePlanInput(raw);
  plan.approval = {
    planHash: planHash(plan),
    approvedAt: Date.now(),
    approvedBy: "user",
  };
  return plan;
}

function validate(plan: Plan, mode: "foreground" | "detached" = "foreground") {
  return validatePlan(plan, { provider, mode });
}

/** The set of rules that fired - asserted exactly, so no fixture leaks. */
function rules(report: ValidationReport): RuleId[] {
  return [...new Set(report.findings.map((finding) => finding.rule))].sort();
}

function assertRejectedBy(report: ValidationReport, expected: RuleId[]) {
  assert.equal(report.ok, false, "expected the plan to be rejected");
  assert.deepEqual(rules(report), expected);
  for (const finding of report.findings) {
    // A rule that cannot explain itself is not usable by the model that has
    // to fix the plan.
    assert.ok(
      finding.message.length > 20,
      `finding for ${finding.rule} has no readable reason`,
    );
  }
}

test("a legal plan passes, in the foreground and detached", () => {
  const plan = build();
  const foreground = validate(plan);
  assert.deepEqual(foreground.findings, []);
  assert.equal(foreground.ok, true);

  const detached = validate(plan, "detached");
  assert.deepEqual(detached.findings, []);
  assert.equal(detached.ok, true);

  assert.match(
    describeValidationReport(foreground),
    /passes V1-V10 for a foreground run/,
  );
});

test("V1 rejects a step whose procedure the provider does not have", () => {
  const report = validate(
    build((plan) => {
      plan.steps[1].procedure = "teleport";
    }),
  );
  assertRejectedBy(report, ["V1"]);
  assert.match(report.findings[0]!.message, /teleport/);
});

test("V2 rejects an edge the provider does not allow", () => {
  const report = validate(
    build((plan) => {
      // spec -> review skips implement, which the catalog does not permit.
      plan.steps[2].blockedBy = ["s1-spec"];
    }),
  );
  assertRejectedBy(report, ["V2"]);
  assert.match(report.findings[0]!.message, /not a legal transition/);
});

test("V2 is not reported for an edge out of an unknown procedure", () => {
  // V1 already says the procedure does not exist; saying its edges are illegal
  // too would be one problem reported as two.
  const report = validate(
    build((plan) => {
      plan.steps[0].procedure = "teleport";
    }),
  );
  assertRejectedBy(report, ["V1"]);
});

test("V3 rejects a cycle", () => {
  const report = validate(
    build((plan) => {
      plan.steps[0].blockedBy = ["s3-review"];
    }),
  );
  assert.equal(report.ok, false);
  assert.ok(rules(report).includes("V3"));
  const cycle = report.findings.find((finding) =>
    finding.message.includes("cycle"),
  );
  assert.ok(cycle, "expected the cycle to be named");
  assert.match(cycle.message, /s1-spec/);
});

test("V3 rejects an edge to a step that does not exist", () => {
  const report = validate(
    build((plan) => {
      plan.steps[1].blockedBy = ["s0-imaginary"];
    }),
  );
  assert.ok(rules(report).includes("V3"));
  assert.match(
    report.findings.find((finding) => finding.rule === "V3")!.message,
    /s0-imaginary/,
  );
});

test("V3 rejects a step connected to nothing", () => {
  const report = validate(
    build((plan) => {
      plan.steps.push({
        id: "s9-orphan",
        kind: "serial",
        mode: "AFK",
        procedure: "handoff",
        label: "Orphaned handoff",
        blockedBy: [],
        brief: "Write the handoff.",
        gate: gate(),
        escalation: 1,
        effects: "readonly",
      });
    }),
  );
  assertRejectedBy(report, ["V3"]);
  assert.match(report.findings[0]!.message, /connected to nothing/);
});

test("V4 rejects an AFK step with no gate", () => {
  const report = validate(
    build((plan) => {
      delete plan.steps[1].gate;
    }),
  );
  assertRejectedBy(report, ["V4"]);
  assert.match(report.findings[0]!.message, /no gate/);
});

test("V4 accepts a HITL step with no gate", () => {
  // A person is watching; the gate is the person.
  const report = validate(
    build((plan) => {
      plan.steps[1].mode = "HITL";
      delete plan.steps[1].gate;
    }),
  );
  assert.equal(report.ok, true);
});

test("V4 rejects a verify script the repo does not declare", () => {
  const report = validate(
    build((plan) => {
      plan.steps[1].gate.verify = { script: "e2e" };
    }),
  );
  assertRejectedBy(report, ["V4"]);
  assert.match(report.findings[0]!.message, /available: test, lint/);
});

test("V4 rejects a verify script when the repo has no package.json", () => {
  const empty = mkdtempSync(path.join(tmpdir(), "wf-plan-norepo-"));
  const report = validate(
    build((plan) => {
      plan.task.cwd = empty;
    }),
  );
  assertRejectedBy(report, ["V4"]);
  assert.match(report.findings[0]!.message, /no package.json could be read/);
});

test("V5 rejects an L3 step on a run that cannot block", () => {
  const report = validate(
    build((plan) => {
      plan.policy.blockable = false;
      plan.steps[1].escalation = 3;
    }),
  );
  assertRejectedBy(report, ["V5"]);
  assert.match(report.findings[0]!.message, /not blockable/);
});

test("V5 rejects a step above the run's escalation ceiling", () => {
  const report = validate(
    build((plan) => {
      plan.policy.maxEscalation = 1;
      plan.steps[1].escalation = 2;
    }),
  );
  assertRejectedBy(report, ["V5"]);
  assert.match(report.findings[0]!.message, /above the run's ceiling/);
});

test("V5 rejects a step above the provider's ceiling for that procedure", () => {
  const report = validate(
    build((plan) => {
      plan.steps[2].procedure = "handoff";
      plan.steps[2].escalation = 3;
    }),
  );
  assert.ok(rules(report).includes("V5"));
  assert.match(
    report.findings.find((finding) => finding.rule === "V5")!.message,
    /ceiling of L1 that test-provider sets/,
  );
});

test("V6 rejects a plan budget above the engine limit", () => {
  const report = validate(
    build((plan) => {
      plan.budget.agentCalls = 500;
    }),
  );
  assertRejectedBy(report, ["V6"]);
  assert.match(report.findings[0]!.message, /exceeds the engine limit/);
});

test("V6 rejects steps that between them outspend the plan", () => {
  const report = validate(
    build((plan) => {
      plan.budget.agentCalls = 4;
      plan.steps[1].budget.agentCalls = 3;
      plan.steps[2].budget.agentCalls = 3;
    }),
  );
  assertRejectedBy(report, ["V6"]);
  assert.match(report.findings[0]!.message, /more than the plan's budget/);
});

test("V6 rejects a fan-out budgeted for fewer calls than it has items", () => {
  const report = validate(
    build((plan) => {
      plan.steps[2].budget.agentCalls = 1;
    }),
  );
  assertRejectedBy(report, ["V6"]);
  assert.match(report.findings[0]!.message, /fans out to 2 items/);
});

test("V6 rejects concurrency above the engine limit", () => {
  const report = validate(
    build((plan) => {
      plan.budget.concurrency = 16;
    }),
  );
  assertRejectedBy(report, ["V6"]);
  assert.match(report.findings[0]!.message, /concurrency/);
});

test("V7 rejects an inline step in a detached run", () => {
  const plan = build((draftPlan) => {
    draftPlan.steps[1].kind = "inline";
  });
  assert.equal(validate(plan).ok, true, "inline is fine in the foreground");
  assertRejectedBy(validate(plan, "detached"), ["V7"]);
});

test("V7 rejects a HITL step in a detached run", () => {
  const plan = build((draftPlan) => {
    draftPlan.steps[1].mode = "HITL";
  });
  assert.equal(validate(plan).ok, true);
  assertRejectedBy(validate(plan, "detached"), ["V7"]);
});

test("V8 rejects a repo-writing step with no branch to write on", () => {
  const report = validate(
    build((plan) => {
      delete plan.task.branch;
    }),
  );
  assertRejectedBy(report, ["V8"]);
  assert.match(report.findings[0]!.message, /no task.branch/);
});

test("V8 rejects two repo-writing steps that nothing orders", () => {
  const report = validate(
    build((plan) => {
      plan.steps.push({
        id: "s2b-implement",
        kind: "serial",
        mode: "AFK",
        procedure: "implement",
        label: "Implement the other half",
        blockedBy: ["s1-spec"],
        brief: "Implement the rest of the spec.",
        gate: gate(),
        escalation: 1,
        effects: "repo",
      });
      plan.steps[2].blockedBy = ["s2-implement", "s2b-implement"];
    }),
  );
  assertRejectedBy(report, ["V8"]);
  assert.match(report.findings[0]!.message, /can run at once/);
});

test("V8 accepts two repo-writing steps the DAG puts in order", () => {
  const report = validate(
    build((plan) => {
      plan.steps.push({
        id: "s2b-implement",
        kind: "serial",
        mode: "AFK",
        procedure: "implement",
        label: "Implement the other half",
        blockedBy: ["s2-implement"],
        brief: "Implement the rest of the spec.",
        gate: gate(),
        escalation: 1,
        effects: "repo",
      });
      plan.steps[2].blockedBy = ["s2b-implement"];
    }),
  );
  assert.deepEqual(report.findings, []);
});

test("V8 rejects a fan-out that writes the shared checkout", () => {
  // This is the live v1 bug written down as a rule: every sub-agent gets the
  // parent's cwd, so a writing fan-out is N agents editing one working tree.
  const report = validate(
    build((plan) => {
      plan.steps[2].effects = "repo";
    }),
  );
  assertRejectedBy(report, ["V8"]);
  assert.match(report.findings[0]!.message, /must use effects "worktree"/);
});

test("V8 accepts a fan-out that writes isolated worktrees", () => {
  const report = validate(
    build((plan) => {
      plan.steps[2].effects = "worktree";
    }),
  );
  assert.deepEqual(report.findings, []);
});

test("V9 rejects a detached run of a plan that was never approved", () => {
  const plan = build();
  delete plan.approval;
  assert.equal(
    validate(plan).ok,
    true,
    "approval is not required to run in the foreground",
  );
  assertRejectedBy(validate(plan, "detached"), ["V9"]);
});

test("V9 rejects a detached run of a plan edited after approval", () => {
  const plan = build();
  plan.task.title = "Something else entirely";
  const report = validate(plan, "detached");
  assertRejectedBy(report, ["V9"]);
  assert.match(report.findings[0]!.message, /has to be approved again/);
});

test("V10 rejects a blockable detached run with nowhere to send the block", () => {
  const plan = build((draftPlan) => {
    delete draftPlan.policy.notify;
  });
  assert.equal(validate(plan).ok, true);
  assertRejectedBy(validate(plan, "detached"), ["V10"]);
});

test("V10 does not apply to a detached run that cannot block", () => {
  const plan = build((draftPlan) => {
    delete draftPlan.policy.notify;
    draftPlan.policy.blockable = false;
    draftPlan.policy.maxEscalation = 2;
  });
  assert.equal(validate(plan, "detached").ok, true);
});

test("every problem in a broken plan is reported at once", () => {
  // One round of planning should surface everything wrong, not the first
  // thing wrong.
  const report = validate(
    build((plan) => {
      plan.steps[1].procedure = "teleport";
      delete plan.steps[2].gate;
      plan.budget.agentCalls = 500;
      delete plan.task.branch;
    }),
    "detached",
  );
  assert.deepEqual(rules(report), ["V1", "V4", "V6", "V8"]);

  const described = describeValidationReport(report);
  assert.match(described, /Plan rejected for a detached run: 4 problem\(s\)/);
  // Grouped under the rule, so a reader sees which guarantee was broken.
  assert.match(described, /V4 \(every AFK step has a usable gate\)/);
});

test("the report carries a freshly computed hash, not the plan's own claim", () => {
  const plan = build();
  plan.approval!.planHash = "not-the-real-hash";
  const report = validate(plan);
  assert.equal(report.planHash, planHash(plan));
  assert.notEqual(report.planHash, "not-the-real-hash");
});
