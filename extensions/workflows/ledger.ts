/**
 * Append-only agent-call ledger and its replay.
 *
 * A workflow script cannot be paused: it runs as an async function body in a
 * killable child, and a JavaScript continuation cannot be serialized. So
 * resuming does not mean restoring a suspended script - it means running the
 * same script again and answering each `agent()` call that already settled
 * from this ledger instead of paying for it twice.
 *
 * That makes the ledger key the whole design. It cannot be the call's ordinal:
 * `parallel()` hands the next array index to whichever worker finishes first,
 * so invocation order varies between runs. The key is therefore the call's
 * content - prompt, schema, and model selection - plus an occurrence counter,
 * which makes it order-independent. Two calls that hash alike are by
 * definition interchangeable, so which of them claims occurrence 0 does not
 * matter.
 *
 * Replay is deliberately conservative. An entry is reused only when its input
 * still hashes the same and the tree it was computed against is still there;
 * an invalidated entry invalidates everything recorded after it, because
 * sequence order is the only dependency information a script exposes. The
 * cost of being wrong is a re-run, so the fail-safe direction is to re-run.
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import * as path from "node:path";
import type { FailureInfo } from "./failure.ts";
import type { AgentUsage } from "./model.ts";
import { toSerializable, truncateUtf8 } from "./serialization.ts";
import {
  callHadEffects,
  worktreeMatches,
  type WorktreeState,
} from "./worktree.ts";

export const LEDGER_FILE = "ledger.jsonl";
/** Output kept inline in a ledger line; larger answers are truncated. */
export const LEDGER_OUTPUT_MAX_BYTES = 64 * 1024;
/** Guard against a single pathological line making the ledger unreadable. */
export const LEDGER_LINE_MAX_BYTES = 512 * 1024;

/** Field separator for hashing; cannot occur inside a JSON string value. */
const HASH_SEPARATOR = "\u0000";

export interface AgentCallIdentity {
  prompt: string;
  schema?: unknown;
  model?: string;
  provider?: string;
  effort?: string;
}

export interface LedgerEntry {
  seq: number;
  /** `inputHash#occurrence`, the replay lookup key. */
  key: string;
  inputHash: string;
  occurrence: number;
  label: string;
  phase?: string;
  status: "ok" | "failed";
  startedAt: number;
  finishedAt: number;
  /** Tree state observed before the call started. */
  before?: WorktreeState;
  /** Tree state observed after the call settled. */
  after?: WorktreeState;
  output?: string;
  structured?: unknown;
  failure?: FailureInfo;
  usage: AgentUsage;
  model?: string;
  contextWindow?: number;
}

/** Stable JSON: object keys sorted, so an equal schema always hashes alike. */
function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 24) return '"[depth]"';
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item, depth + 1)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const pairs = Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`,
    );
  return `{${pairs.join(",")}}`;
}

/**
 * Hash everything that decides what an agent is asked to do. Model selection
 * is included: the same prompt answered by a different model is a different
 * result, and silently reusing one for the other would be wrong.
 */
export function agentInputHash(identity: AgentCallIdentity): string {
  const hash = createHash("sha256");
  for (const field of [
    identity.prompt,
    identity.schema === undefined ? "" : canonicalJson(identity.schema),
    identity.model ?? "",
    identity.provider ?? "",
    identity.effort ?? "",
  ]) {
    hash.update(field);
    hash.update(HASH_SEPARATOR);
  }
  return hash.digest("hex").slice(0, 32);
}

export function ledgerKey(inputHash: string, occurrence: number): string {
  return `${inputHash}#${occurrence}`;
}

/**
 * Assigns occurrence numbers so repeated identical calls get distinct keys.
 *
 * A counter always starts at zero, including for a resumed attempt: the first
 * identical call of the new attempt has to look up the first recorded one.
 * Seeding from the ledger would shift every key and miss the whole cache. A
 * call beyond what was recorded simply lands on the next free occurrence, so
 * fresh numbering never collides with a key already on disk.
 */
export class OccurrenceCounter {
  private readonly counts = new Map<string, number>();

  next(inputHash: string): number {
    const occurrence = this.counts.get(inputHash) ?? 0;
    this.counts.set(inputHash, occurrence + 1);
    return occurrence;
  }
}

export function ledgerPath(runDir: string): string {
  return path.join(runDir, LEDGER_FILE);
}

function plainWorktree(state: WorktreeState): WorktreeState {
  return {
    available: state.available,
    ...(state.sha === undefined ? {} : { sha: state.sha }),
    clean: state.clean,
  };
}

/**
 * Serialize one entry as a single bounded JSONL line.
 *
 * `safeStringify` is deliberately not used here: it pretty-prints, and a
 * multi-line record would break the one-entry-per-line format the reader
 * depends on. `JSON.stringify` escapes newlines inside strings, so the result
 * is single-line by construction.
 */
export function encodeLedgerEntry(entry: LedgerEntry): string {
  const bounded: LedgerEntry = {
    ...entry,
    // Rebuilt as fresh plain objects on purpose: the shared serializer
    // replaces a repeated object reference with a circular-reference marker,
    // and these two fields decide whether an entry can ever be reused. A
    // caller that happens to pass one state for both would otherwise record a
    // string where the replay expects a tree state, and silently lose its
    // whole cache.
    ...(entry.before === undefined
      ? {}
      : { before: plainWorktree(entry.before) }),
    ...(entry.after === undefined ? {} : { after: plainWorktree(entry.after) }),
    ...(entry.output === undefined
      ? {}
      : { output: truncateUtf8(entry.output, LEDGER_OUTPUT_MAX_BYTES) }),
  };
  const serialize = (value: unknown) =>
    JSON.stringify(
      toSerializable(value, {
        maxDepth: 16,
        maxNodes: 10_000,
        maxStringBytes: LEDGER_OUTPUT_MAX_BYTES,
      }),
    ) ?? "null";

  let line = serialize(bounded);
  if (Buffer.byteLength(line, "utf8") > LEDGER_LINE_MAX_BYTES) {
    // Drop the payload rather than the record: the key and status are what
    // replay needs, and an unwritable line would lose the call entirely.
    const { output: _output, structured: _structured, ...rest } = bounded;
    line = serialize({ ...rest, output: "[omitted: ledger line too large]" });
  }
  return `${line}\n`;
}

/**
 * Append-only writer. One `appendFileSync` per entry keeps a line whole under
 * normal operation; a process killed mid-write can still leave a partial
 * trailing line, which `readLedger` skips.
 */
export class LedgerWriter {
  private readonly runDir: string;
  private seq: number;

  constructor(runDir: string, startSeq = 0) {
    this.runDir = runDir;
    this.seq = startSeq;
  }

  get lastSeq() {
    return this.seq;
  }

  append(entry: Omit<LedgerEntry, "seq">): LedgerEntry {
    const complete: LedgerEntry = { ...entry, seq: ++this.seq };
    appendFileSync(ledgerPath(this.runDir), encodeLedgerEntry(complete));
    return complete;
  }
}

export interface ReadLedgerResult {
  entries: LedgerEntry[];
  /** Lines that could not be parsed, including a partial final write. */
  skipped: number;
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.seq === "number" &&
    typeof candidate.key === "string" &&
    typeof candidate.inputHash === "string" &&
    typeof candidate.occurrence === "number" &&
    (candidate.status === "ok" || candidate.status === "failed")
  );
}

export function readLedger(runDir: string): ReadLedgerResult {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(runDir), "utf8");
  } catch {
    return { entries: [], skipped: 0 };
  }
  const entries: LedgerEntry[] = [];
  let skipped = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isLedgerEntry(parsed)) entries.push(parsed);
      else skipped++;
    } catch {
      skipped++;
    }
  }
  entries.sort((a, b) => a.seq - b.seq);
  return { entries, skipped };
}

export interface InvalidationReason {
  seq: number;
  key: string;
  label: string;
  reason: "worktree-moved" | "after-invalidated";
}

export interface ReplayState {
  /** Entries safe to reuse, by ledger key. */
  reusable: Map<string, LedgerEntry>;
  /** Every entry read, for occurrence seeding and budget accounting. */
  entries: LedgerEntry[];
  invalidated: InvalidationReason[];
  skipped: number;
}

/**
 * Decide which recorded calls a resumed run may reuse.
 *
 * A failed entry is never reused - the point of resuming is to retry it. An
 * entry whose call had effects is reusable only while the tree still matches
 * what it left behind; once one such entry is invalidated, every later entry
 * goes with it, since a script exposes no finer dependency information than
 * the order its calls settled in.
 */
export function replayLedger(options: {
  entries: LedgerEntry[];
  skipped?: number;
  worktree: WorktreeState | undefined;
}): ReplayState {
  const reusable = new Map<string, LedgerEntry>();
  const invalidated: InvalidationReason[] = [];
  let poisoned = false;

  for (const entry of options.entries) {
    if (poisoned) {
      invalidated.push({
        seq: entry.seq,
        key: entry.key,
        label: entry.label,
        reason: "after-invalidated",
      });
      continue;
    }
    if (entry.status !== "ok") {
      // A re-attempt that failed supersedes the earlier success it replaced.
      reusable.delete(entry.key);
      continue;
    }
    if (
      callHadEffects(entry.before, entry.after) &&
      !worktreeMatches(entry.after, options.worktree)
    ) {
      invalidated.push({
        seq: entry.seq,
        key: entry.key,
        label: entry.label,
        reason: "worktree-moved",
      });
      poisoned = true;
      continue;
    }
    reusable.set(entry.key, entry);
  }

  return {
    reusable,
    entries: options.entries,
    invalidated,
    skipped: options.skipped ?? 0,
  };
}

/** One-line summary of what a resume will and will not reuse. */
export function describeReplay(state: ReplayState): string {
  const parts = [`${state.reusable.size} reusable`];
  if (state.invalidated.length > 0) {
    parts.push(`${state.invalidated.length} invalidated`);
  }
  const failed = state.entries.filter(
    (entry) => entry.status === "failed",
  ).length;
  if (failed > 0) parts.push(`${failed} failed`);
  if (state.skipped > 0) parts.push(`${state.skipped} unreadable`);
  return parts.join(", ");
}
