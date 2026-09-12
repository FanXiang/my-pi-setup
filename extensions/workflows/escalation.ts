/**
 * Escalation: what a run does when it needs a human.
 *
 * During execution there is no asking. Clarification belongs to planning, and
 * a run that stops for every judgement call is worthless unattended - while
 * one that never stops ships work built on guesses nobody saw. So a run has
 * exactly three levels, and the level is the conductor's decision, not the
 * worker's:
 *
 * - L1 `assume` - record the assumption and keep going. Most implementation
 *   judgement lands here. The record is the point: an assumption nobody can
 *   read afterwards is the same as a silent guess.
 * - L2 `flag`   - record something the reader must see, without blocking.
 * - L3 `block`  - stop and wait for a person. Reserved for a fact that cannot
 *   be obtained, an action only a human can take, or a decision whose
 *   branches each lose something.
 *
 * A fourth outcome is not an escalation at all: `replan` ends the run because
 * the plan itself is wrong. Waiting for an answer would not help, since the
 * problem is not a missing answer.
 *
 * Blockers are content-addressed exactly like agent calls, which is what lets
 * a resumed run find the answer to the block it raised last time and carry on
 * past it.
 */

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { toSerializable, writeFileAtomic } from "./serialization.ts";

export const ASSUMPTIONS_FILE = "assumptions.jsonl";
export const FLAGS_FILE = "flags.jsonl";
export const ANSWERS_FILE = "answers.jsonl";
export const BLOCKERS_DIR = "blockers";
export const REPLAN_FILE = "replan.json";

/** Caps on script-raised records, so a runaway loop cannot fill the disk. */
export const MAX_ASSUMPTIONS = 200;
export const MAX_FLAGS = 200;
export const MAX_BLOCKERS = 16;

const TEXT_MAX = 4_000;
const CHOICE_MAX = 200;
const MAX_CHOICES = 16;

export interface Assumption {
  stepLabel: string;
  phase?: string;
  /** What would otherwise have been asked. */
  question: string;
  /** What the run proceeded on instead. */
  assumption: string;
  evidence?: string;
  /** An irreversible assumption is reported first; it cannot be walked back. */
  reversible: boolean;
  recordedAt: number;
}

export interface Flag {
  stepLabel: string;
  phase?: string;
  note: string;
  evidence?: string;
  recordedAt: number;
}

/**
 * An Attention Request: a bounded ask for human judgement. Every field is
 * required because a blocker without evidence or a recommendation hands a
 * person a question instead of a decision.
 */
export interface Blocker {
  id: string;
  stepLabel: string;
  phase?: string;
  decision: string;
  evidence: string;
  recommendation: string;
  choices: string[];
  openedAt: number;
  /** Delivery attempts. A blocker nobody was told about is not a real pause. */
  notified: NotifyRecord[];
}

export interface NotifyRecord {
  channel: string;
  at: number;
  ok: boolean;
  detail?: string;
}

export interface Answer {
  id: string;
  choice: string;
  note?: string;
  answeredAt: number;
}

export interface Replan {
  reason: string;
  conflictingEvidence?: string;
  suggestedClarifications: string[];
  recordedAt: number;
}

function text(
  value: unknown,
  field: string,
  options: { required?: boolean } = {},
) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    if (options.required)
      throw new Error(`${field} is required and must be a non-empty string`);
    return undefined;
  }
  return raw.slice(0, TEXT_MAX);
}

/**
 * Validate what a script raised. The script is model-authored, so the contract
 * is enforced here rather than trusted: a blocker missing its recommendation
 * or choices would reach a person as an unanswerable question.
 */
export function normalizeBlockerInput(
  raw: unknown,
  context: { stepLabel: string; phase?: string },
): Omit<Blocker, "id" | "openedAt" | "notified"> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      "block() expects an object with decision, evidence, recommendation, and choices",
    );
  }
  const input = raw as Record<string, unknown>;
  const choicesRaw = input.choices;
  if (!Array.isArray(choicesRaw) || choicesRaw.length === 0) {
    throw new Error("block() requires a non-empty `choices` array");
  }
  const choices = choicesRaw.slice(0, MAX_CHOICES).map((choice, index) => {
    const value = typeof choice === "string" ? choice.trim() : "";
    if (!value)
      throw new Error(`block() choice ${index} must be a non-empty string`);
    return value.slice(0, CHOICE_MAX);
  });
  return {
    stepLabel: context.stepLabel,
    ...(context.phase === undefined ? {} : { phase: context.phase }),
    decision: text(input.decision, "block() `decision`", { required: true })!,
    evidence: text(input.evidence, "block() `evidence`", { required: true })!,
    recommendation: text(input.recommendation, "block() `recommendation`", {
      required: true,
    })!,
    choices,
  };
}

export function normalizeAssumptionInput(
  raw: unknown,
  context: { stepLabel: string; phase?: string },
): Assumption {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("assume() expects an object with question and assumption");
  }
  const input = raw as Record<string, unknown>;
  return {
    stepLabel: context.stepLabel,
    ...(context.phase === undefined ? {} : { phase: context.phase }),
    question: text(input.question, "assume() `question`", { required: true })!,
    assumption: text(input.assumption, "assume() `assumption`", {
      required: true,
    })!,
    ...(() => {
      const evidence = text(input.evidence, "assume() `evidence`");
      return evidence === undefined ? {} : { evidence };
    })(),
    // Default to irreversible: an assumption wrongly marked safe is the one
    // that gets skipped when the report is read.
    reversible: input.reversible === true,
    recordedAt: Date.now(),
  };
}

export function normalizeFlagInput(
  raw: unknown,
  context: { stepLabel: string; phase?: string },
): Flag {
  const input =
    typeof raw === "string"
      ? { note: raw }
      : ((raw ?? {}) as Record<string, unknown>);
  return {
    stepLabel: context.stepLabel,
    ...(context.phase === undefined ? {} : { phase: context.phase }),
    note: text(input.note, "flag() `note`", { required: true })!,
    ...(() => {
      const evidence = text(input.evidence, "flag() `evidence`");
      return evidence === undefined ? {} : { evidence };
    })(),
    recordedAt: Date.now(),
  };
}

export function normalizeReplanInput(raw: unknown): Replan {
  const input =
    typeof raw === "string"
      ? { reason: raw }
      : ((raw ?? {}) as Record<string, unknown>);
  const clarifications = Array.isArray(input.suggestedClarifications)
    ? input.suggestedClarifications
        .slice(0, MAX_CHOICES)
        .map((item) =>
          typeof item === "string" ? item.trim().slice(0, CHOICE_MAX) : "",
        )
        .filter((item) => item.length > 0)
    : [];
  return {
    reason: text(input.reason, "replan() `reason`", { required: true })!,
    ...(() => {
      const evidence = text(input.conflictingEvidence, "replan() evidence");
      return evidence === undefined ? {} : { conflictingEvidence: evidence };
    })(),
    suggestedClarifications: clarifications,
    recordedAt: Date.now(),
  };
}

/**
 * Content-addressed blocker identity, so the same block raised by a resumed
 * run resolves to the answer already given for it.
 */
export function blockerHash(
  input: Pick<Blocker, "decision" | "choices" | "stepLabel">,
): string {
  const hash = createHash("sha256");
  for (const field of [
    input.stepLabel,
    input.decision,
    input.choices.join("\u0000"),
  ]) {
    hash.update(field);
    hash.update("\u0000");
  }
  return hash.digest("hex").slice(0, 24);
}

export function blockerId(hash: string, occurrence: number): string {
  return `${hash}-${occurrence}`;
}

function encodeLine(value: unknown): string {
  return `${
    JSON.stringify(
      toSerializable(value, {
        maxDepth: 8,
        maxNodes: 2_000,
        maxStringBytes: TEXT_MAX,
      }),
    ) ?? "null"
  }\n`;
}

function appendJsonl(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  appendFileSync(filePath, encodeLine(value));
}

function readJsonl<T>(
  filePath: string,
  guard: (value: unknown) => value is T,
): T[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }
  const values: T[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (guard(parsed)) values.push(parsed);
    } catch {
      // A process killed mid-append can leave a partial final line.
    }
  }
  return values;
}

export function appendAssumption(runDir: string, assumption: Assumption) {
  appendJsonl(path.join(runDir, ASSUMPTIONS_FILE), assumption);
}

export function appendFlag(runDir: string, flag: Flag) {
  appendJsonl(path.join(runDir, FLAGS_FILE), flag);
}

export function readAssumptions(runDir: string): Assumption[] {
  return readJsonl(
    path.join(runDir, ASSUMPTIONS_FILE),
    (value): value is Assumption =>
      !!value &&
      typeof value === "object" &&
      typeof (value as Assumption).assumption === "string",
  );
}

export function readFlags(runDir: string): Flag[] {
  return readJsonl(
    path.join(runDir, FLAGS_FILE),
    (value): value is Flag =>
      !!value &&
      typeof value === "object" &&
      typeof (value as Flag).note === "string",
  );
}

export function blockerPath(runDir: string, id: string): string {
  return path.join(runDir, BLOCKERS_DIR, `${id}.json`);
}

export function writeBlocker(runDir: string, blocker: Blocker) {
  writeFileAtomic(
    blockerPath(runDir, blocker.id),
    encodeLine(blocker).trimEnd(),
  );
}

export function readBlocker(runDir: string, id: string): Blocker | undefined {
  try {
    const parsed: unknown = JSON.parse(
      readFileSync(blockerPath(runDir, id), "utf8"),
    );
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof (parsed as Blocker).id === "string"
    ) {
      return parsed as Blocker;
    }
  } catch {
    // Treated as absent.
  }
  return undefined;
}

export function readBlockers(runDir: string): Blocker[] {
  let names: string[] = [];
  try {
    names = readdirSync(path.join(runDir, BLOCKERS_DIR));
  } catch {
    return [];
  }
  const blockers: Blocker[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const blocker = readBlocker(runDir, name.slice(0, -".json".length));
    if (blocker) blockers.push(blocker);
  }
  return blockers.sort((a, b) => a.openedAt - b.openedAt);
}

export function appendAnswer(runDir: string, answer: Answer) {
  appendJsonl(path.join(runDir, ANSWERS_FILE), answer);
}

export function readAnswers(runDir: string): Map<string, Answer> {
  const answers = readJsonl(
    path.join(runDir, ANSWERS_FILE),
    (value): value is Answer =>
      !!value &&
      typeof value === "object" &&
      typeof (value as Answer).id === "string" &&
      typeof (value as Answer).choice === "string",
  );
  // A later answer supersedes an earlier one for the same blocker.
  const byId = new Map<string, Answer>();
  for (const answer of answers) byId.set(answer.id, answer);
  return byId;
}

export function writeReplan(runDir: string, replan: Replan) {
  writeFileAtomic(path.join(runDir, REPLAN_FILE), encodeLine(replan).trimEnd());
}

/** Unanswered blockers, oldest first. */
export function openBlockers(runDir: string): Blocker[] {
  const answered = readAnswers(runDir);
  return readBlockers(runDir).filter((blocker) => !answered.has(blocker.id));
}

/** The human-facing text of a blocker, used by every delivery channel. */
export function describeBlocker(blocker: Blocker, runId: string): string {
  const lines = [
    `Workflow ${runId} is waiting on you.`,
    "",
    `Decision: ${blocker.decision}`,
    `Step: ${blocker.stepLabel}${blocker.phase ? ` (${blocker.phase})` : ""}`,
    "",
    "Evidence:",
    blocker.evidence,
    "",
    `Recommendation: ${blocker.recommendation}`,
    "",
    "Choices:",
    ...blocker.choices.map((choice, index) => `  ${index + 1}. ${choice}`),
    "",
    `Answer with: workflow_answer runId=${runId} blockerId=${blocker.id} choice=<one of the above>`,
  ];
  return lines.join("\n");
}
