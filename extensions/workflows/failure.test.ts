import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyFailure,
  classifyRetryNotice,
  engineFailure,
  parseServerRequestedDelayMs,
} from "./failure.ts";

test("quota limits returned as 429s are terminal, not throttles", () => {
  // The provider reports a subscription limit with 429 semantics. Treating it
  // as a throttle would park the run waiting for a window that never opens.
  for (const message of [
    "429 GoUsageLimitError: Monthly usage limit reached",
    "rate limit exceeded: insufficient_quota",
    "429 too many requests — quota exceeded for this billing period",
  ]) {
    const failure = classifyFailure({
      stopReason: "error",
      errorMessage: message,
      sdkRetryable: false,
    });
    assert.equal(failure.class, "quota_exhausted", message);
    assert.equal(failure.transient, false, message);
    assert.equal(failure.throttle, false, message);
  }
});

test("throttles and overload are classified for run-wide pausing", () => {
  const rateLimit = classifyFailure({
    stopReason: "error",
    errorMessage: "429 rate_limit_error: too many requests",
    sdkRetryable: true,
  });
  assert.equal(rateLimit.class, "rate_limit");
  assert.equal(rateLimit.throttle, true);
  assert.equal(rateLimit.transient, true);

  const overloaded = classifyFailure({
    stopReason: "error",
    errorMessage: "529 Overloaded",
    sdkRetryable: true,
  });
  assert.equal(overloaded.class, "overloaded");
  assert.equal(overloaded.throttle, true);
});

test("transport failures are transient but do not throttle the run", () => {
  const failure = classifyFailure({
    stopReason: "error",
    errorMessage: "fetch failed: socket hang up",
    sdkRetryable: true,
  });
  assert.equal(failure.class, "provider_error");
  assert.equal(failure.transient, true);
  assert.equal(failure.throttle, false);
});

test("context overflow and aborts outrank message patterns", () => {
  const overflow = classifyFailure({
    stopReason: "error",
    errorMessage: "429 rate limit",
    contextOverflow: true,
    sdkRetryable: true,
  });
  assert.equal(overflow.class, "context_exhausted");
  assert.equal(overflow.transient, false);
  assert.equal(overflow.throttle, false);

  const aborted = classifyFailure({
    stopReason: "aborted",
    errorMessage: "overloaded",
    sdkRetryable: true,
  });
  assert.equal(aborted.class, "aborted");
  assert.equal(aborted.transient, false);
});

test("engine-side stalls and tool timeouts are recognized", () => {
  const stall = classifyFailure({
    stopReason: "error",
    errorMessage:
      "Agent received no assistant response event for x within 45 seconds; the provider request may be stalled. Retry the workflow.",
  });
  assert.equal(stall.class, "first_response_stall");
  assert.equal(stall.transient, true);

  const toolTimeout = classifyFailure({
    stopReason: "error",
    errorMessage: 'Tool call "bash" timed out after 3 minutes.',
  });
  assert.equal(toolTimeout.class, "tool_timeout");
});

test("the SDK verdict decides transience for unpatterned messages", () => {
  const retryable = classifyFailure({
    stopReason: "error",
    errorMessage: "provider hiccup nobody has a pattern for",
    sdkRetryable: true,
  });
  assert.equal(retryable.class, "provider_error");
  assert.equal(retryable.transient, true);

  const terminal = classifyFailure({
    stopReason: "error",
    errorMessage: "provider hiccup nobody has a pattern for",
    sdkRetryable: false,
  });
  assert.equal(terminal.class, "agent_error");
  assert.equal(terminal.transient, false);
});

test("a missing error message still produces a usable failure", () => {
  const failure = classifyFailure({ stopReason: "error" });
  assert.equal(failure.class, "agent_error");
  assert.equal(failure.message, "Agent failed");
  assert.equal(failure.transient, false);
});

test("server-requested delay is recovered from the over-cap error text", () => {
  assert.equal(
    parseServerRequestedDelayMs(
      "Server requested 90s retry delay (max: 60s). 429 rate limit",
    ),
    90_000,
  );
  assert.equal(parseServerRequestedDelayMs("429 rate limit"), undefined);
  assert.equal(parseServerRequestedDelayMs(undefined), undefined);

  const failure = classifyFailure({
    stopReason: "error",
    errorMessage:
      "Server requested 90s retry delay (max: 60s). 429 rate_limit_error",
    sdkRetryable: true,
  });
  assert.equal(failure.class, "rate_limit");
  assert.equal(failure.retryAfterMs, 90_000);
});

test("retry notices classify from message text alone", () => {
  const notice = classifyRetryNotice("429 rate limit, retrying");
  assert.equal(notice.class, "rate_limit");
  assert.equal(notice.throttle, true);
});

test("engine failures carry their own transience", () => {
  assert.equal(engineFailure("no_structured_output", "nope").transient, false);
  assert.equal(engineFailure("session_create_failed", "nope").transient, true);
  assert.equal(engineFailure("aborted", "stopped").throttle, false);
});
