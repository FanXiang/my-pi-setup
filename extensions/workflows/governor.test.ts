import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_THROTTLE_MS,
  formatThrottle,
  RateLimitGovernor,
  type GovernorSnapshot,
} from "./governor.ts";

/** Fake clock for window math that never calls `wait()`. */
function fakeClock(start = 1_000_000) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

test("a throttle honors the server-requested delay and drops concurrency to one", () => {
  const clock = fakeClock();
  const governor = new RateLimitGovernor(4, { now: clock.now });
  assert.equal(governor.concurrency, 4);
  assert.equal(governor.isThrottled(), false);

  governor.noteThrottle({ retryAfterMs: 30_000, message: "429 rate limit" });
  assert.equal(governor.concurrency, 1);
  assert.equal(governor.isThrottled(), true);
  assert.equal(governor.remainingMs(), 30_000);

  clock.advance(29_999);
  assert.equal(governor.isThrottled(), true);
  clock.advance(1);
  assert.equal(governor.isThrottled(), false);
  assert.equal(governor.remainingMs(), 0);
});

test("a throttle without a server delay uses the default window", () => {
  const clock = fakeClock();
  const governor = new RateLimitGovernor(4, { now: clock.now });
  governor.noteThrottle({ message: "overloaded" });
  assert.equal(governor.remainingMs(), DEFAULT_THROTTLE_MS);
});

test("a window is capped and extends but never shrinks", () => {
  const clock = fakeClock();
  const governor = new RateLimitGovernor(4, {
    now: clock.now,
    maxThrottleMs: 60_000,
  });

  governor.noteThrottle({ retryAfterMs: 600_000, message: "429" });
  assert.equal(governor.remainingMs(), 60_000, "capped at maxThrottleMs");

  // A sibling reports a shorter delay: the longer window must survive.
  governor.noteThrottle({ retryAfterMs: 5_000, message: "429" });
  assert.equal(governor.remainingMs(), 60_000);

  clock.advance(59_000);
  governor.noteThrottle({ retryAfterMs: 10_000, message: "429" });
  assert.equal(governor.remainingMs(), 10_000, "a later throttle extends");
});

test("concurrency recovers additively and stops at the ceiling", () => {
  const clock = fakeClock();
  const governor = new RateLimitGovernor(3, {
    now: clock.now,
    successesToGrow: 2,
  });
  governor.noteThrottle({ message: "429" });
  assert.equal(governor.concurrency, 1);

  governor.noteSuccess();
  assert.equal(governor.concurrency, 1, "one success is not enough");
  governor.noteSuccess();
  assert.equal(governor.concurrency, 2);

  governor.noteSuccess();
  governor.noteFailure();
  assert.equal(governor.concurrency, 2, "a failure resets the streak");
  governor.noteSuccess();
  governor.noteSuccess();
  assert.equal(governor.concurrency, 3);
  governor.noteSuccess();
  governor.noteSuccess();
  assert.equal(governor.concurrency, 3, "never above the ceiling");
});

test("observers see throttles and recovery", () => {
  const clock = fakeClock();
  const governor = new RateLimitGovernor(4, {
    now: clock.now,
    successesToGrow: 1,
  });
  const seen: GovernorSnapshot[] = [];
  const unsubscribe = governor.subscribe((snapshot) => seen.push(snapshot));

  governor.noteThrottle({ retryAfterMs: 1_000, message: "429 rate limit" });
  governor.noteSuccess();
  unsubscribe();
  governor.noteThrottle({ retryAfterMs: 1_000, message: "429 rate limit" });

  assert.deepEqual(
    seen.map((s) => s.concurrency),
    [1, 2],
  );
  assert.equal(seen[0].reason, "429 rate limit");
  assert.equal(seen[0].throttles, 1);
});

test("a failing observer does not break the governor", () => {
  const governor = new RateLimitGovernor(2);
  governor.subscribe(() => {
    throw new Error("observer blew up");
  });
  governor.noteThrottle({ retryAfterMs: 10, message: "429" });
  assert.equal(governor.concurrency, 1);
});

test("wait resolves after the window and sees later extensions", async () => {
  const governor = new RateLimitGovernor(4, { defaultThrottleMs: 40 });
  governor.noteThrottle({ message: "429" });

  const startedAt = Date.now();
  // Extend the window while a caller is already waiting.
  setTimeout(() => governor.noteThrottle({ retryAfterMs: 60 }), 20);
  await governor.wait();
  const waited = Date.now() - startedAt;

  assert.equal(governor.isThrottled(), false);
  assert.ok(
    waited >= 60,
    `waited ${waited}ms, expected to observe the extension`,
  );
});

test("wait resolves immediately when there is no throttle", async () => {
  const governor = new RateLimitGovernor(4);
  await governor.wait();
  assert.equal(governor.isThrottled(), false);
});

test("wait rejects with the caller's abort reason", async () => {
  const governor = new RateLimitGovernor(4, { defaultThrottleMs: 5_000 });
  governor.noteThrottle({ message: "429" });

  const aborted = new AbortController();
  const pending = governor.wait(aborted.signal);
  aborted.abort(new Error("Workflow agent request was cancelled"));
  await assert.rejects(pending, /request was cancelled/);

  const already = new AbortController();
  already.abort(new Error("already gone"));
  await assert.rejects(governor.wait(already.signal), /already gone/);
});

test("formatThrottle renders only while throttled", () => {
  const clock = fakeClock();
  const governor = new RateLimitGovernor(4, { now: clock.now });
  assert.equal(formatThrottle(governor.snapshot()), undefined);

  governor.noteThrottle({ retryAfterMs: 2_500, message: "429" });
  assert.equal(
    formatThrottle(governor.snapshot()),
    "throttled 3s · concurrency 1/4",
  );

  clock.advance(2_500);
  assert.equal(formatThrottle(governor.snapshot()), undefined);
});
