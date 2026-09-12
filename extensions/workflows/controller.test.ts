import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_AGENT_CALLS, RunController } from "./controller.ts";
import { RateLimitGovernor } from "./governor.ts";

const delay = (milliseconds: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

test("RunController reserves calls synchronously and caps global fanout", async () => {
  const controller = new RunController(undefined, 4);
  let active = 0;
  let peak = 0;
  const tasks = Array.from({ length: 12 }, (_, index) =>
    controller.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await delay(5);
      active--;
      return index;
    }),
  );
  assert.deepEqual(
    await Promise.all(tasks),
    Array.from({ length: 12 }, (_, i) => i),
  );
  assert.equal(peak, 4);
  assert.equal(await controller.settle(), true);
});

test("RunController propagates invocation cancellation without aborting the run", async () => {
  const controller = new RunController(undefined, 1);
  const invocation = new AbortController();
  const pending = controller.schedule(
    (signal) =>
      new Promise<string>((resolve) => {
        signal.addEventListener("abort", () => resolve("stopped"), {
          once: true,
        });
      }),
    invocation.signal,
  );

  invocation.abort(new Error("Workflow agent request was cancelled"));
  await assert.rejects(pending, /request was cancelled/);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await controller.schedule(async () => "recovered"), "recovered");
  assert.equal(await controller.settle(), true);
});

test("RunController enforces call budget and aborts queued tasks", async () => {
  const controller = new RunController(undefined, 1);
  const blocker = controller.schedule(
    (signal) =>
      new Promise<void>((resolve) =>
        signal.addEventListener("abort", () => resolve(), { once: true }),
      ),
  );
  const queued = Array.from({ length: MAX_AGENT_CALLS - 1 }, () =>
    controller.schedule(async () => "queued"),
  );
  await assert.rejects(
    controller.schedule(async () => "too many"),
    /exceeded the limit/,
  );
  controller.abort();
  await blocker;
  const results = await Promise.allSettled(queued);
  assert.ok(results.every((result) => result.status === "rejected"));
  assert.equal(await controller.settle({ abort: true }), true);
});

/** Track the highest simultaneous task count over a window of scheduling. */
function peakTracker() {
  let active = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    reset() {
      peak = 0;
    },
    async run(milliseconds: number) {
      active++;
      peak = Math.max(peak, active);
      await delay(milliseconds);
      active--;
    },
  };
}

test("a throttled run starts no new agents until the window clears", async () => {
  const governor = new RateLimitGovernor(4, { defaultThrottleMs: 60 });
  const controller = new RunController(undefined, 4, governor);
  const tracker = peakTracker();
  let started = 0;

  governor.noteThrottle({ message: "429 rate limit" });
  const tasks = Array.from({ length: 3 }, () =>
    controller.schedule(async () => {
      started++;
      await tracker.run(5);
    }),
  );

  await delay(25);
  assert.equal(started, 0, "no agent may start while the run is throttled");

  await Promise.all(tasks);
  assert.equal(started, 3);
  assert.equal(tracker.peak, 1, "concurrency stays collapsed after a throttle");
  assert.equal(await controller.settle(), true);
});

test("a throttle narrows admission without disturbing in-flight agents", async () => {
  const governor = new RateLimitGovernor(2, { defaultThrottleMs: 40 });
  const controller = new RunController(undefined, 2, governor);

  let finished = false;
  const running = controller.schedule(async () => {
    await delay(30);
    finished = true;
    return "done";
  });
  await delay(5);
  governor.noteThrottle({ message: "429 rate limit" });

  assert.equal(await running, "done");
  assert.equal(finished, true);
  assert.equal(controller.signal.aborted, false);
  assert.equal(await controller.settle(), true);
});

test("concurrency reopens as work succeeds again", async () => {
  const governor = new RateLimitGovernor(3, { successesToGrow: 1 });
  const controller = new RunController(undefined, 3, governor);
  const tracker = peakTracker();

  // A zero-length window collapses concurrency without making the test wait.
  governor.noteThrottle({ retryAfterMs: 0, message: "429 rate limit" });
  await Promise.all(
    Array.from({ length: 2 }, () => controller.schedule(() => tracker.run(10))),
  );
  assert.equal(tracker.peak, 1, "collapsed to one while recovering");

  governor.noteSuccess();
  tracker.reset();
  await Promise.all(
    Array.from({ length: 2 }, () => controller.schedule(() => tracker.run(10))),
  );
  assert.equal(tracker.peak, 2, "a success reopens one slot");
  assert.equal(governor.concurrency, 2);
  assert.equal(await controller.settle(), true);
});

test("a run without a governor is unaffected", async () => {
  const controller = new RunController(undefined, 2);
  assert.equal(controller.governor, undefined);
  assert.equal(await controller.schedule(async () => "ok"), "ok");
  assert.equal(await controller.settle(), true);
});
