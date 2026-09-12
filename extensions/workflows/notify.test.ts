import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  blockerHash,
  blockerId,
  normalizeBlockerInput,
  type Blocker,
} from "./escalation.ts";
import {
  deliverBlocker,
  defaultChannels,
  fileChannel,
  NEEDS_INPUT_FILE,
  uiChannel,
  wasDelivered,
  type NotifyChannel,
} from "./notify.ts";

function runDir() {
  return mkdtempSync(path.join(tmpdir(), "wf-notify-"));
}

function blocker(): Blocker {
  const base = normalizeBlockerInput(
    {
      decision: "Which account should the deploy target?",
      evidence: "Two accounts are configured and neither is marked default.",
      recommendation: "Target staging until production is confirmed.",
      choices: ["staging", "production"],
    },
    { stepLabel: "deploy" },
  );
  return {
    ...base,
    id: blockerId(blockerHash(base), 0),
    openedAt: 1_000,
    notified: [],
  };
}

/** Minimal stand-in for the pieces of `ctx.ui` the channel touches. */
function fakeUi() {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify: (message: string, level: string) => {
        notifications.push({ message, level });
      },
    } as never,
  };
}

test("the file channel leaves a marker a person can find later", async () => {
  const dir = runDir();
  const opened = blocker();
  await fileChannel.deliver(opened, { runId: "wf_abc123", runDir: dir });

  const body = readFileSync(path.join(dir, NEEDS_INPUT_FILE), "utf8");
  assert.match(body, /wf_abc123 needs input/);
  assert.match(body, /Which account should the deploy target\?/);
  assert.match(body, /Recommendation: Target staging/);
  assert.match(body, /1\. staging/);
  assert.ok(body.includes(`blockers/${opened.id}.json`));
});

test("the UI channel reports the decision and refuses without a terminal", async () => {
  const { ui, notifications } = fakeUi();
  await uiChannel.deliver(blocker(), {
    runId: "wf_abc123",
    runDir: runDir(),
    ui,
  });
  assert.equal(notifications.length, 1);
  assert.match(notifications[0].message, /waiting on you/);
  assert.equal(notifications[0].level, "warning");

  await assert.rejects(
    uiChannel.deliver(blocker(), { runId: "wf_abc", runDir: runDir() }),
    /no UI attached/,
  );
});

test("a headless run still has the file channel", () => {
  const dir = runDir();
  assert.deepEqual(
    defaultChannels({ runId: "wf_a", runDir: dir }).map((c) => c.name),
    ["file"],
  );
  assert.deepEqual(
    defaultChannels({ runId: "wf_a", runDir: dir, ui: fakeUi().ui }).map(
      (c) => c.name,
    ),
    ["file", "ui"],
  );
});

test("every channel is tried and every attempt is recorded", async () => {
  const failing: NotifyChannel = {
    name: "failing",
    async deliver() {
      throw new Error("transport down");
    },
  };
  const working: NotifyChannel = {
    name: "working",
    async deliver() {},
  };

  const records = await deliverBlocker(
    blocker(),
    { runId: "wf_abc123", runDir: runDir() },
    [failing, working],
  );

  assert.deepEqual(
    records.map((entry) => [entry.channel, entry.ok]),
    [
      ["failing", false],
      ["working", true],
    ],
    "one failing channel must not stop the others",
  );
  assert.equal(records[0].detail, "transport down");
  assert.equal(wasDelivered(records), true);
});

test("a blocker nobody could be told about is not reported as delivered", async () => {
  const records = await deliverBlocker(
    blocker(),
    { runId: "wf_abc123", runDir: runDir() },
    [
      {
        name: "only",
        async deliver() {
          throw new Error("nope");
        },
      },
    ],
  );
  assert.equal(wasDelivered(records), false);
  assert.equal(wasDelivered([]), false, "no channels is not delivery either");
});
