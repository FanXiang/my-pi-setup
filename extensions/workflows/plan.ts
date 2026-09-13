/**
 * Plan IR: what this run will do, frozen before it does any of it.
 *
 * The v1 engine had the model write orchestration JS on the spot, which meant
 * the only description of a run was a program nobody read before it spent
 * money. A Plan is the opposite: data, not code. It can be printed, diffed,
 * validated by rules that live outside the model's head, and hashed - and the
 * hash is what "approved" means. Approval freezes a specific plan, not a
 * general intention.
 *
 * Three properties the IR exists to buy:
 *
 * - **Checkable.** Admission rules V1-V10 (see `validate.ts`) run before the
 *   first agent call, so an illegal run is refused while refusing it is still
 *   free. `allowedNext` in particular stops being a runtime guard that rejects
 *   a bad transition after the work is done, and becomes a type system: an
 *   illegal transition cannot exist in an admitted plan.
 * - **Methodology-free.** Nothing here names a procedure the engine knows
 *   about. `procedure` is an opaque id the provider resolves. Swapping the
 *   provider swaps the methodology without touching this file.
 * - **Reconstructible.** A plan is plain JSON on disk, so an outside process
 *   can read a run's intent without the session that created it.
 *
 * Structural validity is enforced here, at the boundary, because plans are
 * model-authored: `normalizePlanInput` is the only way to get a `Plan`, and it
 * rejects anything malformed rather than letting it reach the scheduler.
 * Semantic admission (does this procedure exist, is this edge legal, does the
 * budget fit) needs a provider and the filesystem, and lives in `validate.ts`.
 */

import { createHash, randomBytes } from "node:crypto";
import { canonicalJson } from "./serialization.ts";

export const PLAN_VERSION = 2;

/** Caps that keep a model-authored plan from becoming a denial of service. */
export const MAX_STEPS = 64;
export const MAX_FANOUT_ITEMS = 32;
export const MAX_NOTIFY_CHANNELS = 8;
export const MAX_PREDICATES = 32;
export const MAX_INPUTS = 16;

const ID_MAX = 64;
const LABEL_MAX = 200;
const TITLE_MAX = 200;
const STATEMENT_MAX = 16_000;
/** Matches the provider-side brief cap; a brief is a document, not a note. */
const BRIEF_MAX = 64 * 1024;
const PATH_MAX = 256;
const PATTERN_MAX = 200;
const MESSAGE_MAX = 1_000;

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const PLAN_ID_PATTERN = /^pl_[0-9a-f]{6,}$/;
/** An npm script name, which is all `gate.verify` is allowed to name. */
const SCRIPT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9:._-]*$/;

/**
 * Path segments that would let a model-authored predicate walk out of the
 * payload it is supposed to be asserting about.
 */
const FORBIDDEN_PATH_SEGMENTS = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

export type StepKind = "inline" | "serial" | "fanout" | "script";
export type StepMode = "HITL" | "AFK";
export type StepEffects = "readonly" | "worktree" | "repo";
export type EscalationLevel = 1 | 2 | 3;
/** How a run is being launched. Several admission rules turn on this. */
export type RunMode = "foreground" | "detached";

export const PREDICATE_OPS = [
  "exists",
  "nonEmpty",
  "minLength",
  "maxLength",
  "eq",
  "ne",
  "matches",
  "everyNonEmpty",
] as const;

export type PredicateOp = (typeof PREDICATE_OPS)[number];

export interface Predicate {
  /** Dot path into the step's structured output, e.g. "acceptance_criteria". */
  path: string;
  op: PredicateOp;
  value?: unknown;
  /** Shown to the sub-agent on failure, so the repair attempt knows the ask. */
  message?: string;
}

/**
 * A repo command a gate may run to check the work, restricted to a script the
 * repository already declares.
 *
 * The plan is a code execution surface: whoever approves it is approving
 * whatever the gate runs. Naming an npm script rather than carrying a shell
 * string means the approver only has to trust the repo's own `scripts`, which
 * they can read once, instead of auditing a command line per plan. The
 * restriction is structural - there is no field here that could hold a shell
 * string - so it cannot be bypassed by a cleverly written plan.
 */
export interface GateVerify {
  /** A key of `scripts` in the package.json at `task.cwd`. */
  script: string;
  /** Exit code that counts as a pass. Defaults to 0. */
  expectExit?: number;
}

export interface Gate {
  /** JSON Schema; the shape the step's `structured_output` must satisfy. */
  schema: unknown;
  predicates: Predicate[];
  verify?: GateVerify;
}

export interface StepInput {
  /** Predecessor step id. */
  from: string;
  /** Field path into that step's structured output. */
  path?: string;
  /** Placeholder name this value is injected into the brief under. */
  as: string;
}

export interface FanoutItem {
  key: string;
  brief: string;
}

export interface StepBudget {
  agentCalls?: number;
  toolTimeoutMs?: number;
  firstResponseMs?: number;
}

export interface StepRetryPolicy {
  /** Step-level re-attempts. Not retries: the SDK already owns those. */
  maxAttempts?: number;
}

export interface StepModel {
  provider?: string;
  id?: string;
  effort?: string;
}

export interface Step {
  /** Unique and stable within the plan, e.g. "s3-implement". */
  id: string;
  kind: StepKind;
  mode: StepMode;
  /** Opaque to the engine; the provider resolves it. */
  procedure: string;
  label: string;
  /** DAG edges: the steps that must settle before this one starts. */
  blockedBy: string[];
  /** The authoritative spec for this step, in AGENT-BRIEF format. */
  brief: string;
  inputs?: StepInput[];
  /** Required for AFK steps: unattended work has to be checkable (V4). */
  gate?: Gate;
  escalation: EscalationLevel;
  effects: StepEffects;
  budget?: StepBudget;
  retry?: StepRetryPolicy;
  fanout?: { items: FanoutItem[]; concurrency?: number };
  model?: StepModel;
}

export interface PlanBudget {
  /** Total for the plan, not per attempt: a resume spends from the same pot. */
  agentCalls: number;
  concurrency: number;
  costUsd?: number;
  wallClockMs?: number;
}

export interface NotifyChannelRef {
  /** Channel id, e.g. "file" or "ui". Resolved against the notify registry. */
  channel: string;
  target?: string;
}

export interface RunPolicy {
  /** Whether this run is allowed to stop and wait for a person at all. */
  blockable: boolean;
  maxEscalation: EscalationLevel;
  onGateFail: "repair-once" | "escalate";
  /** Where an L3 block is delivered. Required for a blockable detached run. */
  notify?: NotifyChannelRef[];
}

export interface PlanTask {
  title: string;
  /** The clarified statement of the work, in prose. */
  statement: string;
  cwd: string;
  baseRef?: string;
  /** Target branch for repo-writing steps. */
  branch?: string;
}

export interface PlanProvider {
  id: string;
  version: string;
  /** Detects provider drift between planning and running. */
  catalogHash: string;
}

export interface PlanApproval {
  planHash: string;
  approvedAt: number;
  approvedBy: "user";
}

export interface Plan {
  version: typeof PLAN_VERSION;
  planId: string;
  workItemId: string;
  task: PlanTask;
  provider: PlanProvider;
  budget: PlanBudget;
  policy: RunPolicy;
  steps: Step[];
  /** Written when a person approves. A plan without it cannot run detached. */
  approval?: PlanApproval;
}

/**
 * The hash covers everything except the approval itself - otherwise approving
 * would change what was approved. Recomputing it at run time and comparing
 * against `approval.planHash` is what makes approval bind to one exact plan
 * rather than to a name.
 */
export function planHash(plan: Plan): string {
  const { approval: _approval, ...rest } = plan;
  return createHash("sha256").update(canonicalJson(rest)).digest("hex");
}

export function isApprovalCurrent(plan: Plan): boolean {
  return (
    plan.approval !== undefined && plan.approval.planHash === planHash(plan)
  );
}

export function newPlanId(): string {
  return `pl_${randomBytes(6).toString("hex")}`;
}

function fail(message: string): never {
  throw new Error(`plan: ${message}`);
}

function text(
  value: unknown,
  field: string,
  max: number,
  options: { required?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) {
    if (options.required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "string") fail(`${field} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) {
    if (options.required) fail(`${field} must not be empty`);
    return undefined;
  }
  if (trimmed.length > max) {
    fail(`${field} must be at most ${max} characters (got ${trimmed.length})`);
  }
  return trimmed;
}

function identifier(value: unknown, field: string): string {
  const raw = text(value, field, ID_MAX, { required: true })!;
  if (!ID_PATTERN.test(raw)) {
    fail(
      `${field} must start alphanumeric and contain only letters, digits, ".", "_" or "-" (got "${raw}")`,
    );
  }
  return raw;
}

function integer(
  value: unknown,
  field: string,
  options: { min?: number; max?: number; required?: boolean } = {},
): number | undefined {
  if (value === undefined || value === null) {
    if (options.required) fail(`${field} is required`);
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    fail(`${field} must be an integer`);
  }
  const min = options.min ?? 0;
  if (value < min) fail(`${field} must be at least ${min} (got ${value})`);
  if (options.max !== undefined && value > options.max) {
    fail(`${field} must be at most ${options.max} (got ${value})`);
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(
      `${field} must be one of ${allowed.join(" | ")} (got ${JSON.stringify(value)})`,
    );
  }
  return value as T;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, field: string, max: number): unknown[] {
  if (!Array.isArray(value)) fail(`${field} must be an array`);
  if (value.length > max) {
    fail(`${field} must have at most ${max} entries (got ${value.length})`);
  }
  return value;
}

function escalationLevel(value: unknown, field: string): EscalationLevel {
  const level = integer(value, field, { min: 1, max: 3, required: true })!;
  return level as EscalationLevel;
}

/**
 * Validate a predicate path and split it into segments.
 *
 * Rejecting the prototype-walking segments here rather than at evaluation time
 * means an admitted plan can never contain one, so no later code path has to
 * remember to guard.
 */
export function parsePredicatePath(path: string, field: string): string[] {
  if (path.length > PATH_MAX) {
    fail(`${field} must be at most ${PATH_MAX} characters`);
  }
  const segments = path.split(".");
  for (const segment of segments) {
    if (!segment) fail(`${field} has an empty segment: "${path}"`);
    if (FORBIDDEN_PATH_SEGMENTS.has(segment)) {
      fail(`${field} must not traverse "${segment}"`);
    }
  }
  return segments;
}

function normalizePredicate(raw: unknown, field: string): Predicate {
  const input = record(raw, field);
  const path = text(input.path, `${field}.path`, PATH_MAX, {
    required: true,
  })!;
  parsePredicatePath(path, `${field}.path`);
  const op = oneOf(input.op, `${field}.op`, PREDICATE_OPS);

  // Operators that compare against a value are useless without one, and the
  // length operators need a number specifically.
  if (op === "minLength" || op === "maxLength") {
    integer(input.value, `${field}.value`, { min: 0, required: true });
  } else if (op === "eq" || op === "ne") {
    if (input.value === undefined) {
      fail(`${field}.value is required for op "${op}"`);
    }
  } else if (op === "matches") {
    const pattern = text(input.value, `${field}.value`, PATTERN_MAX, {
      required: true,
    })!;
    // Compile now so a bad pattern is an admission failure rather than a gate
    // that throws at the one moment the run needed it to answer.
    try {
      new RegExp(pattern);
    } catch (error) {
      fail(
        `${field}.value is not a valid regular expression: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  const message = text(input.message, `${field}.message`, MESSAGE_MAX);
  return {
    path,
    op,
    ...(input.value === undefined ? {} : { value: input.value }),
    ...(message === undefined ? {} : { message }),
  };
}

function normalizeGate(raw: unknown, field: string): Gate {
  const input = record(raw, field);
  if (input.schema === undefined || input.schema === null) {
    fail(`${field}.schema is required`);
  }
  const predicates = array(
    input.predicates ?? [],
    `${field}.predicates`,
    MAX_PREDICATES,
  ).map((predicate, index) =>
    normalizePredicate(predicate, `${field}.predicates[${index}]`),
  );

  let verify: GateVerify | undefined;
  if (input.verify !== undefined && input.verify !== null) {
    const verifyInput = record(input.verify, `${field}.verify`);
    if ("command" in verifyInput) {
      // Named explicitly because this is the shape a model is most likely to
      // reach for, and silently ignoring it would produce a gate that looks
      // like it checks something and does not.
      fail(
        `${field}.verify takes a package.json script name as \`script\`, not a shell \`command\``,
      );
    }
    const script = text(verifyInput.script, `${field}.verify.script`, ID_MAX, {
      required: true,
    })!;
    if (!SCRIPT_NAME_PATTERN.test(script)) {
      fail(
        `${field}.verify.script must be a package.json script name (got "${script}")`,
      );
    }
    const expectExit = integer(
      verifyInput.expectExit ?? 0,
      `${field}.verify.expectExit`,
      { min: 0, max: 255 },
    )!;
    verify = { script, ...(expectExit === 0 ? {} : { expectExit }) };
  }

  return {
    schema: input.schema,
    predicates,
    ...(verify === undefined ? {} : { verify }),
  };
}

function normalizeStep(raw: unknown, index: number): Step {
  const field = `steps[${index}]`;
  const input = record(raw, field);
  const id = identifier(input.id, `${field}.id`);
  const stepField = `step "${id}"`;

  const kind = oneOf(input.kind, `${stepField}.kind`, [
    "inline",
    "serial",
    "fanout",
    "script",
  ] as const);
  const mode = oneOf(input.mode, `${stepField}.mode`, ["HITL", "AFK"] as const);
  const effects = oneOf(input.effects, `${stepField}.effects`, [
    "readonly",
    "worktree",
    "repo",
  ] as const);

  const blockedBy = array(
    input.blockedBy ?? [],
    `${stepField}.blockedBy`,
    MAX_STEPS,
  ).map((entry, entryIndex) =>
    identifier(entry, `${stepField}.blockedBy[${entryIndex}]`),
  );
  if (blockedBy.includes(id)) {
    fail(`${stepField} cannot block itself`);
  }
  if (new Set(blockedBy).size !== blockedBy.length) {
    fail(`${stepField}.blockedBy contains duplicates`);
  }

  const inputs = input.inputs
    ? array(input.inputs, `${stepField}.inputs`, MAX_INPUTS).map(
        (entry, entryIndex) => {
          const inputField = `${stepField}.inputs[${entryIndex}]`;
          const entryRecord = record(entry, inputField);
          const from = identifier(entryRecord.from, `${inputField}.from`);
          const inputPath = text(
            entryRecord.path,
            `${inputField}.path`,
            PATH_MAX,
          );
          if (inputPath !== undefined) {
            parsePredicatePath(inputPath, `${inputField}.path`);
          }
          return {
            from,
            ...(inputPath === undefined ? {} : { path: inputPath }),
            as: identifier(entryRecord.as, `${inputField}.as`),
          };
        },
      )
    : undefined;

  let fanout: Step["fanout"];
  if (kind === "fanout") {
    const fanoutInput = record(input.fanout, `${stepField}.fanout`);
    const items = array(
      fanoutInput.items,
      `${stepField}.fanout.items`,
      MAX_FANOUT_ITEMS,
    ).map((item, itemIndex) => {
      const itemField = `${stepField}.fanout.items[${itemIndex}]`;
      const itemRecord = record(item, itemField);
      return {
        key: identifier(itemRecord.key, `${itemField}.key`),
        brief: text(itemRecord.brief, `${itemField}.brief`, BRIEF_MAX, {
          required: true,
        })!,
      };
    });
    if (items.length === 0) {
      fail(`${stepField}.fanout.items must not be empty`);
    }
    const keys = items.map((item) => item.key);
    if (new Set(keys).size !== keys.length) {
      fail(`${stepField}.fanout.items have duplicate keys`);
    }
    const concurrency = integer(
      fanoutInput.concurrency,
      `${stepField}.fanout.concurrency`,
      { min: 1 },
    );
    fanout = {
      items,
      ...(concurrency === undefined ? {} : { concurrency }),
    };
  } else if (input.fanout !== undefined) {
    fail(`${stepField}.fanout is only valid on a "fanout" step`);
  }

  const budgetInput = input.budget
    ? record(input.budget, `${stepField}.budget`)
    : undefined;
  const budget: StepBudget | undefined = budgetInput
    ? {
        ...(budgetInput.agentCalls === undefined
          ? {}
          : {
              agentCalls: integer(
                budgetInput.agentCalls,
                `${stepField}.budget.agentCalls`,
                { min: 1 },
              )!,
            }),
        ...(budgetInput.toolTimeoutMs === undefined
          ? {}
          : {
              toolTimeoutMs: integer(
                budgetInput.toolTimeoutMs,
                `${stepField}.budget.toolTimeoutMs`,
                { min: 1_000 },
              )!,
            }),
        ...(budgetInput.firstResponseMs === undefined
          ? {}
          : {
              firstResponseMs: integer(
                budgetInput.firstResponseMs,
                `${stepField}.budget.firstResponseMs`,
                { min: 1_000 },
              )!,
            }),
      }
    : undefined;

  const retryInput = input.retry
    ? record(input.retry, `${stepField}.retry`)
    : undefined;
  const retry: StepRetryPolicy | undefined = retryInput
    ? {
        ...(retryInput.maxAttempts === undefined
          ? {}
          : {
              maxAttempts: integer(
                retryInput.maxAttempts,
                `${stepField}.retry.maxAttempts`,
                { min: 1, max: 5 },
              )!,
            }),
      }
    : undefined;

  const modelInput = input.model
    ? record(input.model, `${stepField}.model`)
    : undefined;
  const model: StepModel | undefined = modelInput
    ? (() => {
        const provider = text(
          modelInput.provider,
          `${stepField}.model.provider`,
          ID_MAX,
        );
        const modelId = text(modelInput.id, `${stepField}.model.id`, ID_MAX);
        const effort = text(
          modelInput.effort,
          `${stepField}.model.effort`,
          ID_MAX,
        );
        return {
          ...(provider === undefined ? {} : { provider }),
          ...(modelId === undefined ? {} : { id: modelId }),
          ...(effort === undefined ? {} : { effort }),
        };
      })()
    : undefined;

  return {
    id,
    kind,
    mode,
    procedure: identifier(input.procedure, `${stepField}.procedure`),
    label: text(input.label, `${stepField}.label`, LABEL_MAX, {
      required: true,
    })!,
    blockedBy,
    brief: text(input.brief, `${stepField}.brief`, BRIEF_MAX, {
      required: true,
    })!,
    ...(inputs === undefined || inputs.length === 0 ? {} : { inputs }),
    ...(input.gate === undefined || input.gate === null
      ? {}
      : { gate: normalizeGate(input.gate, `${stepField}.gate`) }),
    escalation: escalationLevel(input.escalation, `${stepField}.escalation`),
    effects,
    ...(budget === undefined || Object.keys(budget).length === 0
      ? {}
      : { budget }),
    ...(retry === undefined || Object.keys(retry).length === 0
      ? {}
      : { retry }),
    ...(fanout === undefined ? {} : { fanout }),
    ...(model === undefined || Object.keys(model).length === 0
      ? {}
      : { model }),
  };
}

function normalizePolicy(raw: unknown): RunPolicy {
  const input = record(raw, "policy");
  const notify = input.notify
    ? array(input.notify, "policy.notify", MAX_NOTIFY_CHANNELS).map(
        (entry, index) => {
          const field = `policy.notify[${index}]`;
          // A bare string is the common case ("file"), so accept it rather
          // than make every plan spell out an object.
          const entryRecord =
            typeof entry === "string"
              ? { channel: entry }
              : record(entry, field);
          const target = text(entryRecord.target, `${field}.target`, PATH_MAX);
          return {
            channel: identifier(entryRecord.channel, `${field}.channel`),
            ...(target === undefined ? {} : { target }),
          };
        },
      )
    : undefined;

  if (typeof input.blockable !== "boolean") {
    fail("policy.blockable must be a boolean");
  }

  return {
    blockable: input.blockable,
    maxEscalation: escalationLevel(input.maxEscalation, "policy.maxEscalation"),
    onGateFail: oneOf(input.onGateFail, "policy.onGateFail", [
      "repair-once",
      "escalate",
    ] as const),
    ...(notify === undefined || notify.length === 0 ? {} : { notify }),
  };
}

function normalizeBudget(raw: unknown): PlanBudget {
  const input = record(raw, "budget");
  const costUsd =
    input.costUsd === undefined || input.costUsd === null
      ? undefined
      : (() => {
          if (typeof input.costUsd !== "number" || !(input.costUsd > 0)) {
            fail("budget.costUsd must be a positive number");
          }
          return input.costUsd;
        })();
  return {
    agentCalls: integer(input.agentCalls, "budget.agentCalls", {
      min: 1,
      required: true,
    })!,
    concurrency: integer(input.concurrency, "budget.concurrency", {
      min: 1,
      required: true,
    })!,
    ...(costUsd === undefined ? {} : { costUsd }),
    ...(input.wallClockMs === undefined
      ? {}
      : {
          wallClockMs: integer(input.wallClockMs, "budget.wallClockMs", {
            min: 1_000,
          })!,
        }),
  };
}

/**
 * Parse a model-authored plan into a `Plan`, or throw explaining what is
 * wrong.
 *
 * This is a boundary, not a convenience: every other module in the conductor
 * may assume a `Plan` value is structurally sound, which is only true because
 * nothing else constructs one.
 */
export function normalizePlanInput(raw: unknown): Plan {
  const input = record(raw, "plan");

  if (input.version !== undefined && input.version !== PLAN_VERSION) {
    fail(
      `version must be ${PLAN_VERSION} (got ${JSON.stringify(input.version)})`,
    );
  }

  const planId =
    input.planId === undefined || input.planId === null
      ? newPlanId()
      : (() => {
          const value = text(input.planId, "planId", ID_MAX, {
            required: true,
          })!;
          if (!PLAN_ID_PATTERN.test(value)) {
            fail(`planId must look like pl_<hex> (got "${value}")`);
          }
          return value;
        })();

  const taskInput = record(input.task, "task");
  const task: PlanTask = {
    title: text(taskInput.title, "task.title", TITLE_MAX, { required: true })!,
    statement: text(taskInput.statement, "task.statement", STATEMENT_MAX, {
      required: true,
    })!,
    cwd: text(taskInput.cwd, "task.cwd", PATH_MAX, { required: true })!,
    ...(() => {
      const baseRef = text(taskInput.baseRef, "task.baseRef", ID_MAX);
      return baseRef === undefined ? {} : { baseRef };
    })(),
    ...(() => {
      const branch = text(taskInput.branch, "task.branch", PATH_MAX);
      return branch === undefined ? {} : { branch };
    })(),
  };

  const providerInput = record(input.provider, "provider");
  const provider: PlanProvider = {
    id: identifier(providerInput.id, "provider.id"),
    version: text(providerInput.version, "provider.version", ID_MAX, {
      required: true,
    })!,
    catalogHash: text(
      providerInput.catalogHash,
      "provider.catalogHash",
      ID_MAX,
      {
        required: true,
      },
    )!,
  };

  const steps = array(input.steps, "steps", MAX_STEPS).map(normalizeStep);
  if (steps.length === 0) fail("steps must not be empty");

  let approval: PlanApproval | undefined;
  if (input.approval !== undefined && input.approval !== null) {
    const approvalInput = record(input.approval, "approval");
    approval = {
      planHash: text(approvalInput.planHash, "approval.planHash", ID_MAX, {
        required: true,
      })!,
      approvedAt: integer(approvalInput.approvedAt, "approval.approvedAt", {
        min: 1,
        required: true,
      })!,
      approvedBy: oneOf(approvalInput.approvedBy, "approval.approvedBy", [
        "user",
      ] as const),
    };
  }

  return {
    version: PLAN_VERSION,
    planId,
    workItemId: identifier(input.workItemId, "workItemId"),
    task,
    provider,
    budget: normalizeBudget(input.budget),
    policy: normalizePolicy(input.policy),
    steps,
    ...(approval === undefined ? {} : { approval }),
  };
}

/** Steps keyed by id. Ids are unique in an admitted plan (V3). */
export function stepsById(plan: Plan): Map<string, Step> {
  const map = new Map<string, Step>();
  for (const step of plan.steps) {
    if (!map.has(step.id)) map.set(step.id, step);
  }
  return map;
}
