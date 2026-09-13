/**
 * Gates: turning "done" from something a step claims into something the
 * engine can check.
 *
 * An unattended step reports its own success, which is exactly the claim least
 * worth trusting - a sub-agent that ran out of road will still write a
 * confident summary. A gate is the second opinion: the step's structured
 * output has to satisfy assertions written down before the step ran.
 *
 * The predicate language is deliberately not JavaScript. It is eight
 * operators over a dot path, and that is the whole of it, because:
 *
 * - it is evaluated *outside* the sandbox, in the engine's own process, and a
 *   plan is model-authored - a JS predicate would be a fresh eval surface in
 *   the one place we removed one;
 * - it has to serialize into the ledger, so a later reader can see not just
 *   that a gate failed but what it asserted;
 * - it has to be auditable by whoever approves the plan, and an expression
 *   language nobody reads is not a check, it is decoration.
 *
 * Eight operators is a narrow start on purpose. Widening the language later is
 * cheap; taking an operator back once plans depend on it is not.
 *
 * Order of judgement (spec 3.2): schema, then predicates, then `verify`. The
 * schema half is already enforced upstream - a step with a gate supplies that
 * schema as the sub-agent's `structured_output` shape, so a payload that does
 * not fit never becomes a result in the first place. What is left for this
 * module is the part a schema cannot express: not "is there a field called
 * acceptance_criteria" but "does it actually have anything in it".
 *
 * A gate failure is not transient (spec 5.4). Retrying an unchanged call
 * produces the same payload and the same verdict; what a failed gate needs is
 * a repair attempt that has been told what was wrong, which is what
 * `describeGateFailures` is for.
 */

import { canonicalJson } from "./serialization.ts";
import { parsePredicatePath, type Gate, type Predicate } from "./plan.ts";

/** Cap on what a `matches` predicate is handed, as cheap ReDoS insurance. */
const MATCH_INPUT_MAX = 16 * 1024;

export interface PathResolution {
  found: boolean;
  value: unknown;
}

/**
 * Walk a dot path into a structured payload.
 *
 * A numeric segment indexes an array, so "risks.0.severity" works. Paths were
 * checked at admission (`parsePredicatePath`), so prototype-walking segments
 * cannot appear in an admitted plan; the check is repeated here anyway because
 * this function is also reachable from tests and future callers, and a
 * defensive check costs nothing against a payload that is, after all, written
 * by a model.
 */
export function resolvePath(payload: unknown, path: string): PathResolution {
  const segments = parsePredicatePath(path, `predicate path "${path}"`);
  let current: unknown = payload;
  for (const segment of segments) {
    if (current === null || current === undefined)
      return { found: false, value: undefined };
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(segment)) return { found: false, value: undefined };
      const index = Number(segment);
      if (index >= current.length) return { found: false, value: undefined };
      current = current[index];
      continue;
    }
    if (typeof current !== "object") return { found: false, value: undefined };
    const record = current as Record<string, unknown>;
    if (!Object.prototype.hasOwnProperty.call(record, segment)) {
      return { found: false, value: undefined };
    }
    current = record[segment];
  }
  return { found: true, value: current };
}

/**
 * Present and carrying content.
 *
 * Whitespace does not count as content: a sub-agent that filled a required
 * field with a space satisfied the schema and answered nothing. Numbers and
 * booleans are content, including `0` and `false` - they are answers, and
 * treating them as empty would make the operator unusable for any field whose
 * legitimate value happens to be zero.
 */
function isNonEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") {
    return Object.keys(value as Record<string, unknown>).length > 0;
  }
  return true;
}

/** Length for the length operators; `undefined` when the type has no length. */
function measurableLength(value: unknown): number | undefined {
  // Strings are trimmed so padding cannot buy a minLength.
  if (typeof value === "string") return value.trim().length;
  if (Array.isArray(value)) return value.length;
  return undefined;
}

function describeValue(value: unknown): string {
  if (value === undefined) return "missing";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 60
      ? `"${trimmed.slice(0, 57)}..."`
      : `"${trimmed}"`;
  }
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (value === null) return "null";
  if (typeof value === "object") return "an object";
  return String(value);
}

export interface GateFailure {
  path: string;
  op: Predicate["op"];
  /** Readable, and written for the sub-agent that has to fix it. */
  message: string;
}

export interface GateResult {
  ok: boolean;
  failures: GateFailure[];
  /** Predicate count that passed, for the ledger line and the dashboard. */
  passed: number;
}

/**
 * Judge one predicate. Returns `undefined` when it holds, or the reason it
 * does not.
 *
 * The reason is always the predicate's own `message` when it has one: the
 * plan author knows what this field is for, and a generated sentence about
 * minLength is a worse repair instruction than the sentence a human wrote.
 */
export function evaluatePredicate(
  payload: unknown,
  predicate: Predicate,
): GateFailure | undefined {
  const { found, value } = resolvePath(payload, predicate.path);
  const reason = (generated: string): GateFailure => ({
    path: predicate.path,
    op: predicate.op,
    message: predicate.message ?? generated,
  });

  switch (predicate.op) {
    case "exists":
      return found && value !== null && value !== undefined
        ? undefined
        : reason(`${predicate.path} is missing`);

    case "nonEmpty":
      return isNonEmpty(value)
        ? undefined
        : reason(`${predicate.path} is empty (${describeValue(value)})`);

    case "minLength": {
      const length = measurableLength(value);
      const want = predicate.value as number;
      if (length === undefined) {
        return reason(
          `${predicate.path} has no length to measure; expected a string or array, got ${describeValue(value)}`,
        );
      }
      return length >= want
        ? undefined
        : reason(
            `${predicate.path} needs at least ${want} ${
              Array.isArray(value) ? "entries" : "characters"
            }, got ${length}`,
          );
    }

    case "maxLength": {
      const length = measurableLength(value);
      const want = predicate.value as number;
      if (length === undefined) {
        return reason(
          `${predicate.path} has no length to measure; expected a string or array, got ${describeValue(value)}`,
        );
      }
      return length <= want
        ? undefined
        : reason(
            `${predicate.path} allows at most ${want} ${
              Array.isArray(value) ? "entries" : "characters"
            }, got ${length}`,
          );
    }

    case "eq":
      // Compared canonically so key order in an object value is not a
      // difference; two payloads that mean the same thing compare equal.
      return canonicalJson(value) === canonicalJson(predicate.value)
        ? undefined
        : reason(
            `${predicate.path} must equal ${describeValue(predicate.value)}, got ${describeValue(value)}`,
          );

    case "ne":
      return canonicalJson(value) !== canonicalJson(predicate.value)
        ? undefined
        : reason(
            `${predicate.path} must not equal ${describeValue(predicate.value)}`,
          );

    case "matches": {
      if (typeof value !== "string") {
        return reason(
          `${predicate.path} must be a string to match against, got ${describeValue(value)}`,
        );
      }
      // The pattern compiled at admission, so this cannot throw on a plan that
      // passed validation.
      const pattern = new RegExp(predicate.value as string);
      return pattern.test(value.slice(0, MATCH_INPUT_MAX))
        ? undefined
        : reason(
            `${predicate.path} does not match /${predicate.value as string}/`,
          );
    }

    case "everyNonEmpty": {
      if (!Array.isArray(value)) {
        return reason(
          `${predicate.path} must be an array, got ${describeValue(value)}`,
        );
      }
      if (value.length === 0) {
        return reason(`${predicate.path} is an empty array`);
      }
      const emptyAt = value.findIndex((entry) => !isNonEmpty(entry));
      return emptyAt === -1
        ? undefined
        : reason(`${predicate.path}[${emptyAt}] is empty`);
    }
  }
}

/**
 * Evaluate a gate's predicates against a step's structured output.
 *
 * Every predicate is evaluated - the loop does not stop at the first failure -
 * because the point is to hand the repair attempt the complete list. Telling a
 * sub-agent about one missing field at a time turns one repair into four.
 */
export function evaluateGate(payload: unknown, gate: Gate): GateResult {
  const failures: GateFailure[] = [];
  for (const predicate of gate.predicates) {
    const failure = evaluatePredicate(payload, predicate);
    if (failure) failures.push(failure);
  }
  return {
    ok: failures.length === 0,
    failures,
    passed: gate.predicates.length - failures.length,
  };
}

/** The repair instruction handed back to the sub-agent on a failed gate. */
export function describeGateFailures(failures: GateFailure[]): string {
  if (failures.length === 0) return "";
  const lines = failures.map((failure) => `- ${failure.message}`);
  return [
    `The result did not pass ${failures.length} check(s):`,
    ...lines,
    "Produce a corrected structured result that satisfies all of them.",
  ].join("\n");
}
