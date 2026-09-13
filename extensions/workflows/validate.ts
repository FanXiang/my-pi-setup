/**
 * Plan admission: V1-V10, the rules a plan has to survive before it may run.
 *
 * These are the teeth. Everything else in the conductor assumes a plan is
 * sane; this is the one file that checks. The rules run before the first agent
 * call, which is the only moment when refusing a plan is free - after that,
 * rejecting it means throwing away work somebody paid for.
 *
 * Two kinds of checking, split deliberately:
 *
 * - **Structural** validity - field types, enum values, required fields, well
 *   formed predicate paths - is enforced in `normalizePlanInput`, at the point
 *   the plan is parsed. A `Plan` value is structurally sound by construction.
 * - **Semantic** admission is here, because it needs things a parser does not
 *   have: a provider to ask whether a procedure exists, the DAG as a whole to
 *   ask whether two steps can run at once, the filesystem to ask whether a
 *   verify script is real.
 *
 * Every rule reports rather than throws, and evaluation never stops at the
 * first failure. A plan with four problems should come back with four
 * problems: the alternative is four rounds of re-planning, each revealing one
 * more thing that was wrong from the start.
 */

import { MAX_AGENT_CALLS, MAX_CONCURRENCY } from "./controller.ts";
import { isBoundedJsonObject } from "./serialization.ts";
import { proceduresById, type MethodologyProvider } from "./provider.ts";
import {
  isApprovalCurrent,
  planHash,
  stepsById,
  type Plan,
  type RunMode,
  type Step,
} from "./plan.ts";
import { readFileSync } from "node:fs";
import * as path from "node:path";

export const RULE_IDS = [
  "V1",
  "V2",
  "V3",
  "V4",
  "V5",
  "V6",
  "V7",
  "V8",
  "V9",
  "V10",
] as const;

export type RuleId = (typeof RULE_IDS)[number];

export const RULE_TITLES: Record<RuleId, string> = {
  V1: "every step's procedure exists in the provider",
  V2: "every DAG edge is a legal procedure transition",
  V3: "the step graph is a connected DAG with a root",
  V4: "every AFK step has a usable gate",
  V5: "escalation levels fit the run policy",
  V6: "budgets fit inside the plan and the engine",
  V7: "a detached run contains nothing that needs the session",
  V8: "repo-writing steps cannot collide",
  V9: "a detached run is running the plan that was approved",
  V10: "a blockable detached run can reach a person",
};

export interface ValidationFinding {
  rule: RuleId;
  /** Readable on its own - this is what the model or the user is shown. */
  message: string;
  stepId?: string;
}

export interface ValidationReport {
  ok: boolean;
  findings: ValidationFinding[];
  /** Recomputed here so a caller never has to trust the plan's own copy. */
  planHash: string;
  mode: RunMode;
}

export interface EngineLimits {
  agentCalls: number;
  concurrency: number;
}

export interface ValidationOptions {
  provider: MethodologyProvider;
  /** Several rules only bite on a detached run. */
  mode: RunMode;
  limits?: Partial<EngineLimits>;
  /**
   * Reads the declared npm scripts of the repo a plan targets. Injectable so
   * the rules can be tested without a package.json on disk.
   */
  readPackageScripts?: (cwd: string) => string[] | undefined;
}

/** Default reader for V4's verify check. A missing package.json is not an error here - it means "no scripts", and V4 says why that fails. */
export function readPackageScripts(cwd: string): string[] | undefined {
  try {
    const raw = readFileSync(path.join(cwd, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, unknown> };
    if (!parsed.scripts || typeof parsed.scripts !== "object") return [];
    return Object.keys(parsed.scripts);
  } catch {
    return undefined;
  }
}

interface Graph {
  steps: Map<string, Step>;
  successors: Map<string, string[]>;
  /** Transitive closure: `reaches.get(a)` is every step that must follow a. */
  reaches: Map<string, Set<string>>;
  cycles: string[][];
}

function buildGraph(plan: Plan): Graph {
  const steps = stepsById(plan);
  const successors = new Map<string, string[]>();
  for (const step of plan.steps) successors.set(step.id, []);
  for (const step of plan.steps) {
    for (const predecessor of step.blockedBy) {
      const list = successors.get(predecessor);
      if (list) list.push(step.id);
    }
  }

  // Depth-first cycle detection, recording one representative path per cycle
  // so the finding can name the loop instead of just asserting one exists.
  const cycles: string[][] = [];
  const state = new Map<string, "open" | "closed">();
  const stack: string[] = [];
  const walk = (id: string) => {
    const seen = state.get(id);
    if (seen === "closed") return;
    if (seen === "open") {
      const start = stack.indexOf(id);
      cycles.push([...stack.slice(start === -1 ? 0 : start), id]);
      return;
    }
    state.set(id, "open");
    stack.push(id);
    for (const next of successors.get(id) ?? []) walk(next);
    stack.pop();
    state.set(id, "closed");
  };
  for (const step of plan.steps) walk(step.id);

  // Transitive closure by memoized descent. Plans are capped at 64 steps, so
  // the naive closure is far cheaper than the machinery to avoid it.
  const reaches = new Map<string, Set<string>>();
  const descend = (id: string, guard: Set<string>): Set<string> => {
    const cached = reaches.get(id);
    if (cached) return cached;
    if (guard.has(id)) return new Set();
    guard.add(id);
    const result = new Set<string>();
    for (const next of successors.get(id) ?? []) {
      result.add(next);
      for (const beyond of descend(next, guard)) result.add(beyond);
    }
    guard.delete(id);
    // Only memoize once the walk is cycle-free below this node; caching a
    // truncated result would make reachability depend on visit order.
    if (cycles.length === 0) reaches.set(id, result);
    return result;
  };
  for (const step of plan.steps) descend(step.id, new Set());

  return { steps, successors, reaches, cycles };
}

/** Whether two steps could ever be in flight at the same time. */
function canBeConcurrent(graph: Graph, a: string, b: string): boolean {
  if (a === b) return false;
  return (
    !(graph.reaches.get(a)?.has(b) ?? false) &&
    !(graph.reaches.get(b)?.has(a) ?? false)
  );
}

export function validatePlan(
  plan: Plan,
  options: ValidationOptions,
): ValidationReport {
  const findings: ValidationFinding[] = [];
  const add = (rule: RuleId, message: string, stepId?: string) => {
    findings.push({
      rule,
      message,
      ...(stepId === undefined ? {} : { stepId }),
    });
  };

  const detached = options.mode === "detached";
  const limits: EngineLimits = {
    agentCalls: options.limits?.agentCalls ?? MAX_AGENT_CALLS,
    concurrency: options.limits?.concurrency ?? MAX_CONCURRENCY,
  };
  const graph = buildGraph(plan);
  const procedures = proceduresById(options.provider);

  // ---- V1: the procedure exists ----------------------------------------
  for (const step of plan.steps) {
    if (!procedures.has(step.procedure)) {
      add(
        "V1",
        `step "${step.id}" names procedure "${step.procedure}", which provider ${options.provider.id} does not have`,
        step.id,
      );
    }
  }

  // ---- V2: the edge is a legal transition -------------------------------
  // Skipped where V1 already failed: "unknown procedure" and "illegal edge out
  // of an unknown procedure" are one problem, and reporting both twice makes
  // the report harder to act on.
  for (const step of plan.steps) {
    if (!procedures.has(step.procedure)) continue;
    for (const predecessorId of step.blockedBy) {
      const predecessor = graph.steps.get(predecessorId);
      if (!predecessor || !procedures.has(predecessor.procedure)) continue;
      if (
        !options.provider.validateEdge(predecessor.procedure, step.procedure)
      ) {
        add(
          "V2",
          `edge "${predecessorId}" -> "${step.id}" is not a legal transition: ${options.provider.id} does not allow "${predecessor.procedure}" to be followed by "${step.procedure}"`,
          step.id,
        );
      }
    }
  }

  // ---- V3: it is actually a DAG -----------------------------------------
  const seenIds = new Set<string>();
  for (const step of plan.steps) {
    if (seenIds.has(step.id)) {
      add("V3", `step id "${step.id}" is used more than once`, step.id);
    }
    seenIds.add(step.id);
  }
  for (const step of plan.steps) {
    for (const predecessorId of step.blockedBy) {
      if (!graph.steps.has(predecessorId)) {
        add(
          "V3",
          `step "${step.id}" is blocked by "${predecessorId}", which is not a step in this plan`,
          step.id,
        );
      }
    }
  }
  for (const cycle of graph.cycles) {
    add("V3", `the step graph has a cycle: ${cycle.join(" -> ")}`);
  }
  const roots = plan.steps.filter((step) => step.blockedBy.length === 0);
  if (roots.length === 0) {
    add(
      "V3",
      "every step is blocked by another, so nothing can start; a plan needs at least one step with no predecessors",
    );
  }
  if (plan.steps.length > 1) {
    for (const step of plan.steps) {
      const isolated =
        step.blockedBy.length === 0 &&
        (graph.successors.get(step.id)?.length ?? 0) === 0;
      if (isolated) {
        add(
          "V3",
          `step "${step.id}" is connected to nothing else in the plan; either give it an edge or make it its own plan`,
          step.id,
        );
      }
    }
  }

  // ---- V4: an unattended step has to be checkable -----------------------
  const scripts = options.readPackageScripts ?? readPackageScripts;
  let declaredScripts: string[] | undefined;
  let scriptsRead = false;
  for (const step of plan.steps) {
    if (step.mode === "AFK" && !step.gate) {
      add(
        "V4",
        `step "${step.id}" runs unattended (AFK) but has no gate; an AFK step reports its own success, so something has to check it`,
        step.id,
      );
      continue;
    }
    if (!step.gate) continue;

    if (!isBoundedJsonObject(step.gate.schema)) {
      add(
        "V4",
        `step "${step.id}" has a gate whose schema is not a bounded JSON object`,
        step.id,
      );
    }

    const verify = step.gate.verify;
    if (!verify) continue;
    if (!scriptsRead) {
      declaredScripts = scripts(plan.task.cwd);
      scriptsRead = true;
    }
    if (declaredScripts === undefined) {
      add(
        "V4",
        `step "${step.id}" verifies with script "${verify.script}", but no package.json could be read at ${plan.task.cwd}`,
        step.id,
      );
    } else if (!declaredScripts.includes(verify.script)) {
      add(
        "V4",
        `step "${step.id}" verifies with script "${verify.script}", which is not declared in ${path.join(plan.task.cwd, "package.json")}${
          declaredScripts.length > 0
            ? ` (available: ${declaredScripts.join(", ")})`
            : " (it declares no scripts)"
        }`,
        step.id,
      );
    }
  }

  // ---- V5: escalation fits the policy -----------------------------------
  for (const step of plan.steps) {
    if (step.escalation > plan.policy.maxEscalation) {
      add(
        "V5",
        `step "${step.id}" escalates to L${step.escalation}, above the run's ceiling of L${plan.policy.maxEscalation}`,
        step.id,
      );
    }
    if (step.escalation === 3 && !plan.policy.blockable) {
      add(
        "V5",
        `step "${step.id}" escalates to L3 (stop and wait for a person), but this run is not blockable`,
        step.id,
      );
    }
    const procedure = procedures.get(step.procedure);
    if (
      procedure?.maxEscalation !== undefined &&
      step.escalation > procedure.maxEscalation
    ) {
      add(
        "V5",
        `step "${step.id}" escalates to L${step.escalation}, above the ceiling of L${procedure.maxEscalation} that ${options.provider.id} sets for procedure "${step.procedure}"`,
        step.id,
      );
    }
  }

  // ---- V6: budgets add up -----------------------------------------------
  if (plan.budget.agentCalls > limits.agentCalls) {
    add(
      "V6",
      `plan budget of ${plan.budget.agentCalls} agent calls exceeds the engine limit of ${limits.agentCalls}`,
    );
  }
  if (plan.budget.concurrency > limits.concurrency) {
    add(
      "V6",
      `plan concurrency of ${plan.budget.concurrency} exceeds the engine limit of ${limits.concurrency}`,
    );
  }
  const declaredTotal = plan.steps.reduce(
    (total, step) => total + (step.budget?.agentCalls ?? 0),
    0,
  );
  if (declaredTotal > plan.budget.agentCalls) {
    add(
      "V6",
      `steps declare ${declaredTotal} agent calls between them, more than the plan's budget of ${plan.budget.agentCalls}`,
    );
  }
  for (const step of plan.steps) {
    const items = step.fanout?.items.length ?? 0;
    const stepCalls = step.budget?.agentCalls;
    if (items > 0 && stepCalls !== undefined && stepCalls < items) {
      add(
        "V6",
        `step "${step.id}" fans out to ${items} items but budgets only ${stepCalls} agent call(s)`,
        step.id,
      );
    }
  }

  // ---- V7: a detached run cannot depend on the session -------------------
  if (detached) {
    for (const step of plan.steps) {
      if (step.kind === "inline") {
        add(
          "V7",
          `step "${step.id}" is an inline step, which runs in the main session; a detached run has no session to run it in`,
          step.id,
        );
      }
      if (step.mode === "HITL") {
        add(
          "V7",
          `step "${step.id}" is HITL, which expects a person at the keyboard; a detached run has nobody there`,
          step.id,
        );
      }
    }
  }

  // ---- V8: writers cannot collide ---------------------------------------
  // The rule this encodes is a live bug in v1: every sub-agent is handed the
  // parent's cwd, and the concurrency cap is 4. A read-only fan-out is fine; a
  // writing one has four agents editing one checkout.
  const repoWriters = plan.steps.filter((step) => step.effects === "repo");
  for (const step of repoWriters) {
    if (!plan.task.branch) {
      add(
        "V8",
        `step "${step.id}" writes the repository but the plan declares no task.branch to write it on`,
        step.id,
      );
    }
    if (step.kind === "fanout") {
      add(
        "V8",
        `step "${step.id}" fans out ${step.fanout?.items.length ?? 0} agents that each write the repository; a fan-out that writes must use effects "worktree" so each agent gets its own checkout`,
        step.id,
      );
    }
  }
  for (let i = 0; i < repoWriters.length; i += 1) {
    for (let j = i + 1; j < repoWriters.length; j += 1) {
      const a = repoWriters[i]!;
      const b = repoWriters[j]!;
      if (canBeConcurrent(graph, a.id, b.id)) {
        add(
          "V8",
          `steps "${a.id}" and "${b.id}" both write the repository and nothing orders them, so they can run at once; add an edge between them or move one into a worktree`,
          a.id,
        );
      }
    }
  }

  // ---- V9: a detached run runs what was approved ------------------------
  const currentHash = planHash(plan);
  if (detached) {
    if (!plan.approval) {
      add(
        "V9",
        "a detached run requires an approved plan, and this plan has no approval",
      );
    } else if (!isApprovalCurrent(plan)) {
      add(
        "V9",
        `the plan changed after it was approved (approved ${plan.approval.planHash.slice(0, 12)}, now ${currentHash.slice(0, 12)}); it has to be approved again`,
      );
    }
  }

  // ---- V10: a blockable detached run can reach someone -------------------
  if (detached && plan.policy.blockable) {
    if (!plan.policy.notify || plan.policy.notify.length === 0) {
      add(
        "V10",
        "this run may stop and wait for a person, but runs detached with no notify channel, so nobody would ever learn it is waiting",
      );
    }
  }

  return {
    ok: findings.length === 0,
    findings,
    planHash: currentHash,
    mode: options.mode,
  };
}

/** Render a report for a tool result or the dashboard. */
export function describeValidationReport(report: ValidationReport): string {
  if (report.ok) {
    return `Plan passes V1-V10 for a ${report.mode} run. planHash ${report.planHash.slice(0, 12)}`;
  }
  const byRule = new Map<RuleId, ValidationFinding[]>();
  for (const finding of report.findings) {
    const list = byRule.get(finding.rule) ?? [];
    list.push(finding);
    byRule.set(finding.rule, list);
  }
  const lines: string[] = [
    `Plan rejected for a ${report.mode} run: ${report.findings.length} problem(s).`,
  ];
  for (const rule of RULE_IDS) {
    const entries = byRule.get(rule);
    if (!entries) continue;
    lines.push(`${rule} (${RULE_TITLES[rule]}):`);
    for (const entry of entries) lines.push(`  - ${entry.message}`);
  }
  return lines.join("\n");
}
