/**
 * Methodology Provider: the read-only seam between the engine and whatever
 * body of practice a plan is drawn from.
 *
 * The engine deliberately knows no methodology. It does not know what
 * "to-spec" means, which phase follows which, or what a good brief looks like;
 * it knows how to schedule a DAG, record what happened, and stop when a gate
 * says stop. Everything else is a provider's to say. `pi-matt-pocock` is the
 * first one (M6), but nothing here names it.
 *
 * Two constraints make the seam worth having rather than merely present:
 *
 * - **Read-only.** A provider answers questions. It cannot run anything,
 *   schedule anything, or decide anything at run time. Every provider answer
 *   is consumed during planning and frozen into the Plan, so a run's behaviour
 *   depends on the plan on disk and not on what a provider would say today.
 * - **No leakage.** The engine imports these generic types and never a
 *   provider's own concepts (design invariant 2). A procedure id is an opaque
 *   string here and stays one.
 *
 * `catalogHash` exists because the freeze is only as good as our ability to
 * notice it has thawed: a plan records the hash it was built against, so a
 * provider that changed underneath an approved plan is detectable rather than
 * silently in effect.
 */

import type { Gate, Step, StepKind, EscalationLevel } from "./plan.ts";

export interface ProcedureMeta {
  id: string;
  kind: "workflow" | "reference" | "utility" | "asset";
  phases: string[];
  /** Procedure ids that may legally follow this one. */
  allowedNext: string[];
  requires: string[];
  discloses: string[];
  standalone: boolean;
  /** Advisory: a plan may override these, and the validators judge the plan. */
  defaultStepKind?: StepKind;
  defaultEffects?: Step["effects"];
  /**
   * A real ceiling, not advice: V5 rejects a plan that escalates a step past
   * it. A provider that knows a procedure must never stop and wait for a
   * person is the only party in a position to say so.
   */
  maxEscalation?: EscalationLevel;
}

export interface BriefContext {
  task: { title: string; statement: string; cwd: string };
  workItemId: string;
  /** Structured outputs of predecessor steps, keyed by the input's `as`. */
  inputs?: Record<string, unknown>;
}

export interface TaskStatement {
  title: string;
  statement: string;
  cwd: string;
  workItemId: string;
}

/**
 * A provider's suggested skeleton: steps without the parts only the session
 * knows. The engine treats a draft as untrusted input exactly like a
 * model-authored plan - it goes through `normalizePlanInput` and the
 * validators the same way.
 */
export interface PlanDraft {
  steps: Array<Partial<Step> & { procedure: string }>;
  notes?: string[];
}

export interface MethodologyProvider {
  id: string;
  version: string;
  /** Detects provider drift between the moment of planning and of running. */
  catalogHash: string;

  listProcedures(): ProcedureMeta[];
  loadBrief(procedureId: string, ctx: BriefContext): Promise<string>;
  gateFor(procedureId: string): Gate | undefined;
  /**
   * Whether a `from -> to` transition is legal.
   *
   * In v1 this check lived at run time and could only reject a transition
   * after the work leading to it was already paid for. Here it runs at
   * admission (V2), which turns `allowedNext` from a guard into a type system:
   * an illegal transition does not exist in an admitted plan.
   */
  validateEdge(from: string, to: string): boolean;

  /**
   * Optional: a provider-side plan skeleton.
   *
   * Declared, deliberately unimplemented. Plan synthesis is the session
   * model's job (decision Q2a): it reads `listProcedures()` and composes,
   * and the validators - not the provider - are what make the result safe.
   * Starting there keeps methodology out of the engine and keeps one obvious
   * place where a plan can be wrong. A provider that can do better than the
   * model at skeleton-building can fill this in later without the engine
   * changing, which is the whole reason the hook is here rather than absent.
   */
  suggestPlan?(task: TaskStatement): PlanDraft;
}

/** Procedures keyed by id, for the validators that ask about them. */
export function proceduresById(
  provider: MethodologyProvider,
): Map<string, ProcedureMeta> {
  const map = new Map<string, ProcedureMeta>();
  for (const procedure of provider.listProcedures()) {
    if (!map.has(procedure.id)) map.set(procedure.id, procedure);
  }
  return map;
}

/**
 * Installed providers, keyed by id.
 *
 * A registry rather than a hard-coded import is what keeps the engine
 * methodology-free in practice and not just in principle: this file has no way
 * to name a provider, so nothing here can quietly come to depend on one. A
 * provider package registers itself at load; until one does, a plan naming it
 * is refused rather than validated against nothing, because a plan whose
 * procedures were never checked has not really passed V1.
 */
const providers = new Map<string, MethodologyProvider>();

export function registerMethodologyProvider(
  provider: MethodologyProvider,
): void {
  providers.set(provider.id, provider);
}

export function getMethodologyProvider(
  id: string,
): MethodologyProvider | undefined {
  return providers.get(id);
}

export function listMethodologyProviders(): MethodologyProvider[] {
  return [...providers.values()];
}

/** Test seam; a running session registers once at load and never clears. */
export function clearMethodologyProviders(): void {
  providers.clear();
}
