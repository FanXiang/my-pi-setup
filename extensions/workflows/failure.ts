/**
 * Workflow failure classification.
 *
 * The SDK already owns the retryable-vs-terminal decision: `agent-session`
 * retries a failed turn with backoff (`settings.retry`, default 3 attempts)
 * using `isRetryableAssistantError()`, and `pi-ai` retries the HTTP request
 * itself honoring `retry-after` (`settings.retry.provider`). By the time an
 * outcome reaches the engine, those budgets are spent.
 *
 * What the engine still needs, and what this module supplies, is *which kind*
 * of failure it was, so a run can route it: throttles pause run-wide
 * scheduling instead of letting every sibling agent hammer the same quota,
 * quota exhaustion stops the run instead of waiting, and context overflow is
 * left to compaction. The patterns here only pick the sub-class; pass the
 * SDK's own verdict in `sdkRetryable` and it decides `transient`.
 */

export type FailureClass =
  /** Provider throttle: waiting is the only cure. */
  | "rate_limit"
  /** Provider is over capacity (529/503). Same treatment as a throttle. */
  | "overloaded"
  /** Transient server, transport, or stream failure. */
  | "provider_error"
  /** A request opened but never produced its first assistant event. */
  | "first_response_stall"
  /** One child tool call exceeded its execution timeout. */
  | "tool_timeout"
  /** Subscription, budget, or billing limit. Waiting does not help. */
  | "quota_exhausted"
  /** Conversation no longer fits the context window; compaction's job. */
  | "context_exhausted"
  /** Cancelled by the run, the parent turn, or the user. */
  | "aborted"
  /** The model finished but failed the task, or returned an unusable answer. */
  | "agent_error"
  /** A schema was supplied but `structured_output` was never called. */
  | "no_structured_output"
  /** The child session could not be created at all. */
  | "session_create_failed"
  /** Engine bug or unrecognized error. */
  | "internal";

export interface FailureInfo {
  class: FailureClass;
  message: string;
  /** True when waiting and re-attempting could plausibly succeed. */
  transient: boolean;
  /** True when the whole run should pause, not just this step. */
  throttle: boolean;
  /** Server-requested wait, when the provider surfaced one. */
  retryAfterMs?: number;
  model?: string;
}

export interface ClassifyFailureInput {
  stopReason?: string;
  errorMessage?: string;
  aborted?: boolean;
  /** `isContextOverflow()` from `@earendil-works/pi-ai`. */
  contextOverflow?: boolean;
  /**
   * `isRetryableAssistantError()` from `@earendil-works/pi-ai`. It owns the
   * transient decision because its pattern list is the one the SDK's own retry
   * loops use; omit it only when no assistant message exists.
   */
  sdkRetryable?: boolean;
  model?: string;
}

/**
 * Subscription and billing limits that arrive *as* 429s. These must be tested
 * before the throttle patterns: treating them as throttles makes a run wait
 * out a window that will never open.
 */
const QUOTA_PATTERN =
  /GoUsageLimitError|FreeUsageLimitError|insufficient_quota|quota exceeded|out of budget|billing|monthly usage limit reached|available balance/i;

const RATE_LIMIT_PATTERN = /rate.?limit|too many requests|\b429\b/i;

const OVERLOADED_PATTERN =
  /overloaded|\b529\b|\b503\b|service.?unavailable|capacity/i;

const STALL_PATTERN = /no assistant response event/i;

const TOOL_TIMEOUT_PATTERN = /^Tool call ".*" timed out after/i;

const TRANSPORT_PATTERN =
  /\b(500|502|504|524)\b|server.?error|internal.?error|provider.?returned.?error|network.?error|connection.?(error|refused|lost)|other side closed|fetch failed|getaddrinfo|ENOTFOUND|EAI_AGAIN|upstream.?connect|reset before headers|socket (hang up|connection was closed)|websocket.?(closed|error)|terminated|stream ended|timed? out|timeout/i;

/**
 * Recover a server-requested delay from `pi-ai`'s over-cap error text. When a
 * provider asks for longer than `settings.retry.provider.maxRetryDelayMs`
 * (60s by default) the request fails immediately with the requested delay in
 * its message — the only path by which `retry-after` reaches an extension.
 */
export function parseServerRequestedDelayMs(
  message: string | undefined,
): number | undefined {
  if (!message) return undefined;
  const match = /Server requested (\d+(?:\.\d+)?)s retry delay/i.exec(message);
  if (!match) return undefined;
  const seconds = Number.parseFloat(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return Math.round(seconds * 1000);
}

function info(
  failureClass: FailureClass,
  message: string,
  flags: { transient: boolean; throttle?: boolean },
  input: ClassifyFailureInput,
): FailureInfo {
  const retryAfterMs = parseServerRequestedDelayMs(input.errorMessage);
  return {
    class: failureClass,
    message,
    transient: flags.transient,
    throttle: flags.throttle ?? false,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    ...(input.model === undefined ? {} : { model: input.model }),
  };
}

/** Classify a settled agent failure. Never throws; unknown shapes become `internal`. */
export function classifyFailure(input: ClassifyFailureInput): FailureInfo {
  const message = (input.errorMessage ?? "").trim();

  if (input.aborted || input.stopReason === "aborted") {
    return info(
      "aborted",
      message || "Agent was aborted",
      { transient: false },
      input,
    );
  }
  if (input.contextOverflow) {
    return info(
      "context_exhausted",
      message || "Context window exhausted",
      { transient: false },
      input,
    );
  }
  if (!message) {
    return info("agent_error", "Agent failed", { transient: false }, input);
  }

  // Quota first: these arrive as 429s but waiting never clears them.
  if (QUOTA_PATTERN.test(message)) {
    return info("quota_exhausted", message, { transient: false }, input);
  }
  if (TOOL_TIMEOUT_PATTERN.test(message)) {
    return info("tool_timeout", message, { transient: true }, input);
  }
  if (STALL_PATTERN.test(message)) {
    return info("first_response_stall", message, { transient: true }, input);
  }

  // The SDK's classifier decides transience; the patterns below only choose
  // which transient class it is, so a throttle can pause the whole run.
  const transient = input.sdkRetryable ?? TRANSPORT_PATTERN.test(message);
  if (RATE_LIMIT_PATTERN.test(message)) {
    return info(
      "rate_limit",
      message,
      { transient: true, throttle: true },
      input,
    );
  }
  if (OVERLOADED_PATTERN.test(message)) {
    return info(
      "overloaded",
      message,
      { transient: true, throttle: true },
      input,
    );
  }
  if (transient) {
    return info("provider_error", message, { transient: true }, input);
  }
  return info("agent_error", message, { transient: false }, input);
}

/**
 * Classify the error text observed mid-retry, before the child has settled.
 * `auto_retry_start` carries only a message, so this is the earliest point at
 * which a throttle can be detected — early enough to stop sibling agents from
 * piling onto the same quota.
 */
export function classifyRetryNotice(errorMessage: string): FailureInfo {
  return classifyFailure({
    stopReason: "error",
    errorMessage,
    sdkRetryable: true,
  });
}

/** Engine-originated failures that never reach a provider. */
export function engineFailure(
  failureClass: Extract<
    FailureClass,
    "no_structured_output" | "session_create_failed" | "internal" | "aborted"
  >,
  message: string,
): FailureInfo {
  return {
    class: failureClass,
    message,
    transient: failureClass === "session_create_failed",
    throttle: false,
  };
}
