/**
 * Run-wide rate limit governor.
 *
 * The SDK retries each request on its own, which is the right behavior for a
 * single session and the wrong one for a fan-out: four children that all hit
 * the same 429 each back off independently and then all return together,
 * keeping the quota pinned. Nothing below the run coordinates them, so the
 * governor does: the first throttle any child observes pauses scheduling for
 * every other child, and concurrency recovers additively once work succeeds
 * again (additive increase, multiplicative decrease).
 *
 * It is advisory for in-flight work: a throttle never cancels a running agent,
 * it only stops new ones from starting.
 */

import type { FailureInfo } from "./failure.ts";

/** Wait applied when a throttle carries no server-requested delay. */
export const DEFAULT_THROTTLE_MS = 15_000;
/** Ceiling on any single throttle window, so a bad header cannot park a run. */
export const MAX_THROTTLE_MS = 120_000;
/** Consecutive successes required before concurrency grows by one. */
export const SUCCESSES_TO_GROW = 2;

export interface GovernorSnapshot {
  /** Ceiling from the run's configured concurrency. */
  limit: number;
  /** Concurrency currently allowed. */
  concurrency: number;
  /** Epoch ms until which new agents are held back, when throttled. */
  throttledUntil?: number;
  /** Remaining throttle in ms, zero when not throttled. */
  remainingMs: number;
  /** Why the last throttle was applied. */
  reason?: string;
  throttles: number;
}

export interface GovernorOptions {
  now?: () => number;
  defaultThrottleMs?: number;
  maxThrottleMs?: number;
  successesToGrow?: number;
}

type Listener = (snapshot: GovernorSnapshot) => void;

export class RateLimitGovernor {
  private readonly limitCeiling: number;
  private readonly now: () => number;
  private readonly defaultThrottleMs: number;
  private readonly maxThrottleMs: number;
  private readonly successesToGrow: number;
  private current: number;
  private throttledUntil = 0;
  private reason: string | undefined;
  private consecutiveOk = 0;
  private throttles = 0;
  private listeners = new Set<Listener>();

  constructor(limit: number, options: GovernorOptions = {}) {
    this.limitCeiling = Math.max(1, Math.floor(limit));
    this.current = this.limitCeiling;
    this.now = options.now ?? Date.now;
    this.defaultThrottleMs = options.defaultThrottleMs ?? DEFAULT_THROTTLE_MS;
    this.maxThrottleMs = options.maxThrottleMs ?? MAX_THROTTLE_MS;
    this.successesToGrow = Math.max(
      1,
      options.successesToGrow ?? SUCCESSES_TO_GROW,
    );
  }

  get limit() {
    return this.limitCeiling;
  }

  get concurrency() {
    return this.current;
  }

  remainingMs() {
    return Math.max(0, this.throttledUntil - this.now());
  }

  isThrottled() {
    return this.remainingMs() > 0;
  }

  /**
   * Record a throttle. Windows extend but never shrink, so the longest
   * server-requested delay wins and a late arrival cannot shorten the pause.
   */
  noteThrottle(
    failure: Partial<Pick<FailureInfo, "retryAfterMs" | "message">>,
  ) {
    const requested = failure.retryAfterMs ?? this.defaultThrottleMs;
    const windowMs = Math.min(this.maxThrottleMs, Math.max(0, requested));
    const until = this.now() + windowMs;
    const changed = until > this.throttledUntil || this.current > 1;
    if (until > this.throttledUntil) this.throttledUntil = until;
    this.current = 1;
    this.consecutiveOk = 0;
    // Keep the previous reason when a caller has none to offer.
    if (failure.message) this.reason = failure.message;
    this.throttles++;
    if (changed) this.publish();
  }

  /** Record a non-throttle failure: it costs the growth streak, not concurrency. */
  noteFailure() {
    this.consecutiveOk = 0;
  }

  /** Record a success; concurrency grows by one every `successesToGrow` in a row. */
  noteSuccess() {
    this.consecutiveOk++;
    if (this.consecutiveOk < this.successesToGrow) return;
    this.consecutiveOk = 0;
    if (this.current >= this.limitCeiling) return;
    this.current++;
    this.publish();
  }

  /**
   * Resolve once the throttle window has passed. Rejects with the signal's
   * reason if the caller is cancelled while waiting.
   */
  wait(signal?: AbortSignal): Promise<void> {
    const remaining = this.remainingMs();
    if (remaining <= 0) return Promise.resolve();
    if (signal?.aborted) return Promise.reject(abortReason(signal));
    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        settle();
        reject(abortReason(signal));
      };
      // Deliberately not unref'd: a caller is blocked on this timer, so it is
      // real pending work, not a background tick.
      const timer = setTimeout(() => {
        settle();
        // Another child may have extended the window while this one waited.
        this.wait(signal).then(resolve, reject);
      }, remaining);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  subscribe(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  snapshot(): GovernorSnapshot {
    return {
      limit: this.limitCeiling,
      concurrency: this.current,
      ...(this.throttledUntil > 0
        ? { throttledUntil: this.throttledUntil }
        : {}),
      remainingMs: this.remainingMs(),
      ...(this.reason === undefined ? {} : { reason: this.reason }),
      throttles: this.throttles,
    };
  }

  private publish() {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // A failing observer must not break scheduling.
      }
    }
  }
}

function abortReason(signal?: AbortSignal): Error {
  return signal?.reason instanceof Error
    ? signal.reason
    : new Error("Workflow was aborted");
}

/** Format a governor snapshot for the tool block and dashboard. */
export function formatThrottle(snapshot: GovernorSnapshot): string | undefined {
  if (snapshot.remainingMs <= 0) return undefined;
  const seconds = Math.ceil(snapshot.remainingMs / 1000);
  return `throttled ${seconds}s · concurrency ${snapshot.concurrency}/${snapshot.limit}`;
}
