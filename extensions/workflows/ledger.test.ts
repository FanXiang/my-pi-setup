import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  agentInputHash,
  describeReplay,
  encodeLedgerEntry,
  ledgerKey,
  ledgerPath,
  LedgerWriter,
  OccurrenceCounter,
  readLedger,
  replayLedger,
  type LedgerEntry,
} from "./ledger.ts";
import { emptyUsage } from "./model.ts";
import type { WorktreeState } from "./worktree.ts";

const CLEAN: WorktreeState = { available: true, sha: "aaa", clean: true };
const CLEAN_MOVED: WorktreeState = { available: true, sha: "bbb", clean: true };
const DIRTY: WorktreeState = { available: true, sha: "aaa", clean: false };
const UNKNOWN: WorktreeState = { available: false, clean: false };

function runDir() {
  return mkdtempSync(path.join(tmpdir(), "wf-ledger-"));
}

function entry(overrides: Partial<LedgerEntry> = {}): Omit<LedgerEntry, "seq"> {
  const inputHash = overrides.inputHash ?? "hash1";
  const occurrence = overrides.occurrence ?? 0;
  return {
    key: ledgerKey(inputHash, occurrence),
    inputHash,
    occurrence,
    label: "agent-1",
    status: "ok",
    startedAt: 1,
    finishedAt: 2,
    before: CLEAN,
    after: CLEAN,
    usage: emptyUsage(),
    ...overrides,
  };
}

test("identical calls hash alike and differing selections do not", () => {
  const base = { prompt: "review src/a.ts", schema: { type: "object" } };
  assert.equal(agentInputHash(base), agentInputHash({ ...base }));

  // Key order inside the schema must not change the hash.
  assert.equal(
    agentInputHash({ prompt: "p", schema: { a: 1, b: 2 } }),
    agentInputHash({ prompt: "p", schema: { b: 2, a: 1 } }),
  );

  // Anything that changes the answer must change the hash.
  assert.notEqual(
    agentInputHash(base),
    agentInputHash({ ...base, prompt: "other" }),
  );
  assert.notEqual(
    agentInputHash(base),
    agentInputHash({ ...base, schema: undefined }),
  );
  assert.notEqual(
    agentInputHash(base),
    agentInputHash({ ...base, model: "opus" }),
  );
  assert.notEqual(
    agentInputHash({ ...base, model: "m" }),
    agentInputHash({ ...base, model: "m", provider: "p" }),
  );
  assert.notEqual(
    agentInputHash(base),
    agentInputHash({ ...base, effort: "high" }),
  );
});

test("the hash separator keeps adjacent fields from blurring together", () => {
  // Without a separator "ab" + "" would collide with "a" + "b".
  assert.notEqual(
    agentInputHash({ prompt: "ab", model: "" }),
    agentInputHash({ prompt: "a", model: "b" }),
  );
});

test("repeated identical calls get distinct keys in order", () => {
  const counter = new OccurrenceCounter();
  assert.equal(counter.next("h"), 0);
  assert.equal(counter.next("h"), 1);
  assert.equal(counter.next("other"), 0);
});

test("a resumed attempt restarts numbering so recorded keys are found", () => {
  // Attempt 1 recorded h#0 and h#1. Attempt 2 must produce the same two keys,
  // or the replay would miss every entry it is supposed to reuse.
  const first = new OccurrenceCounter();
  const keysOf = (counter: OccurrenceCounter) => [
    ledgerKey("h", counter.next("h")),
    ledgerKey("h", counter.next("h")),
  ];
  assert.deepEqual(keysOf(first), ["h#0", "h#1"]);
  assert.deepEqual(keysOf(new OccurrenceCounter()), ["h#0", "h#1"]);
});

test("a later failure supersedes an earlier success for the same key", () => {
  const state = replayLedger({
    entries: [
      { ...entry({ label: "first try", inputHash: "h" }), seq: 1 },
      {
        ...entry({ label: "re-attempt", inputHash: "h", status: "failed" }),
        seq: 2,
      },
    ],
    worktree: CLEAN,
  });
  assert.equal(
    state.reusable.size,
    0,
    "a stale success must not outlive the retry that failed",
  );
});

test("entries round-trip through an append-only file", () => {
  const dir = runDir();
  const writer = new LedgerWriter(dir);
  writer.append(entry({ label: "first" }));
  writer.append(entry({ label: "second", inputHash: "hash2" }));

  const { entries, skipped } = readLedger(dir);
  assert.equal(skipped, 0);
  assert.deepEqual(
    entries.map((e) => [e.seq, e.label]),
    [
      [1, "first"],
      [2, "second"],
    ],
  );

  // A second writer continues the sequence rather than restarting it.
  const resumed = new LedgerWriter(dir, entries[entries.length - 1].seq);
  resumed.append(entry({ label: "third" }));
  assert.deepEqual(
    readLedger(dir).entries.map((e) => e.seq),
    [1, 2, 3],
  );
});

test("a partial final line is skipped, not fatal", () => {
  const dir = runDir();
  const writer = new LedgerWriter(dir);
  writer.append(entry({ label: "complete" }));
  // Simulate a process killed mid-append.
  const whole = readFileSync(ledgerPath(dir), "utf8");
  writeFileSync(ledgerPath(dir), `${whole}{"seq":2,"key":"tru`);

  const { entries, skipped } = readLedger(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].label, "complete");
  assert.equal(skipped, 1);
});

test("a missing ledger reads as empty", () => {
  const { entries, skipped } = readLedger(runDir());
  assert.deepEqual(entries, []);
  assert.equal(skipped, 0);
});

test("an oversized entry keeps its key and loses its payload", () => {
  const line = encodeLedgerEntry({
    ...entry({ output: "x".repeat(2 * 1024 * 1024) }),
    seq: 1,
  });
  const parsed = JSON.parse(line) as LedgerEntry;
  assert.equal(parsed.key, ledgerKey("hash1", 0));
  assert.equal(parsed.status, "ok");
  assert.ok(Buffer.byteLength(line, "utf8") <= 512 * 1024 + 1);
  assert.ok(line.endsWith("\n"));
});

test("a read-only call survives a later commit", () => {
  const state = replayLedger({
    entries: [{ ...entry({ before: CLEAN, after: CLEAN }), seq: 1 }],
    worktree: CLEAN_MOVED,
  });
  assert.equal(state.reusable.size, 1, "no effects means nothing to pin");
  assert.deepEqual(state.invalidated, []);
});

test("a call that moved HEAD is invalidated once the tree moves again", () => {
  const wrote = { ...entry({ before: CLEAN, after: CLEAN_MOVED }), seq: 1 };

  const unchanged = replayLedger({ entries: [wrote], worktree: CLEAN_MOVED });
  assert.equal(unchanged.reusable.size, 1, "same tree, still reusable");

  const moved = replayLedger({ entries: [wrote], worktree: CLEAN });
  assert.equal(moved.reusable.size, 0);
  assert.deepEqual(
    moved.invalidated.map((i) => [i.seq, i.reason]),
    [[1, "worktree-moved"]],
  );
});

test("a call that dirtied the tree is pinned to that dirty state", () => {
  const dirtied = { ...entry({ before: CLEAN, after: DIRTY }), seq: 1 };
  assert.equal(
    replayLedger({ entries: [dirtied], worktree: DIRTY }).reusable.size,
    1,
  );
  assert.equal(
    replayLedger({ entries: [dirtied], worktree: CLEAN }).reusable.size,
    0,
  );
});

test("an unprobeable tree is never assumed safe", () => {
  const unknown = { ...entry({ before: UNKNOWN, after: UNKNOWN }), seq: 1 };
  assert.equal(
    replayLedger({ entries: [unknown], worktree: CLEAN }).reusable.size,
    0,
    "unknown effects must not be reused",
  );
  assert.equal(
    replayLedger({ entries: [unknown], worktree: undefined }).reusable.size,
    0,
  );
});

test("invalidating one entry invalidates everything recorded after it", () => {
  const state = replayLedger({
    entries: [
      {
        ...entry({ label: "a", inputHash: "h1", before: CLEAN, after: CLEAN }),
        seq: 1,
      },
      {
        ...entry({
          label: "b",
          inputHash: "h2",
          before: CLEAN,
          after: CLEAN_MOVED,
        }),
        seq: 2,
      },
      {
        ...entry({ label: "c", inputHash: "h3", before: CLEAN, after: CLEAN }),
        seq: 3,
      },
    ],
    worktree: CLEAN,
  });

  assert.deepEqual(
    [...state.reusable.values()].map((e) => e.label),
    ["a"],
  );
  assert.deepEqual(
    state.invalidated.map((i) => [i.label, i.reason]),
    [
      ["b", "worktree-moved"],
      ["c", "after-invalidated"],
    ],
  );
});

test("failed entries are retried rather than reused", () => {
  const state = replayLedger({
    entries: [
      { ...entry({ label: "ok", inputHash: "h1" }), seq: 1 },
      { ...entry({ label: "bad", inputHash: "h2", status: "failed" }), seq: 2 },
    ],
    worktree: CLEAN,
  });
  assert.equal(state.reusable.size, 1);
  assert.equal(state.reusable.has(ledgerKey("h2", 0)), false);
  assert.deepEqual(state.invalidated, [], "a retry is not an invalidation");
});

test("the replay summary reports every category", () => {
  const state = replayLedger({
    entries: [
      { ...entry({ inputHash: "h1" }), seq: 1 },
      { ...entry({ inputHash: "h2", status: "failed" }), seq: 2 },
      {
        ...entry({ inputHash: "h3", before: CLEAN, after: CLEAN_MOVED }),
        seq: 3,
      },
    ],
    skipped: 1,
    worktree: CLEAN,
  });
  assert.equal(
    describeReplay(state),
    "1 reusable, 1 invalidated, 1 failed, 1 unreadable",
  );
});

/**
 * Model of how a run drives the ledger: resolve a key per call in invocation
 * order, answer from the replay when it has one, otherwise run and record.
 * `stopAfter` stands in for a process killed mid-run.
 */
function simulateAttempt(
  dir: string,
  prompts: string[],
  options: { stopAfter?: number; worktree?: WorktreeState } = {},
) {
  const worktree = options.worktree ?? CLEAN;
  const { entries, skipped } = readLedger(dir);
  const replay = replayLedger({ entries, skipped, worktree });
  const occurrences = new OccurrenceCounter();
  const writer = new LedgerWriter(dir, entries.at(-1)?.seq ?? 0);

  const ran: string[] = [];
  const reused: string[] = [];
  // Earlier attempts already charged for every call they recorded.
  let budgetUsed = entries.length;

  for (const [index, prompt] of prompts.entries()) {
    const inputHash = agentInputHash({ prompt });
    const key = ledgerKey(inputHash, occurrences.next(inputHash));
    if (replay.reusable.has(key)) {
      reused.push(prompt);
      continue;
    }
    if (options.stopAfter !== undefined && ran.length >= options.stopAfter) {
      break;
    }
    ran.push(prompt);
    budgetUsed++;
    writer.append({
      ...entry({ inputHash, label: prompt }),
      occurrence: Number(key.slice(key.indexOf("#") + 1)),
      key,
      startedAt: index,
      finishedAt: index + 1,
      before: worktree,
      after: worktree,
    });
  }
  return {
    ran,
    reused,
    budgetUsed,
    invalidated: replay.invalidated.map((item) => item.reason),
  };
}

test("a resumed run pays only for the calls that had not settled", () => {
  const dir = runDir();
  const prompts = ["one", "two", "three", "four", "five"];

  const killed = simulateAttempt(dir, prompts, { stopAfter: 2 });
  assert.deepEqual(killed.ran, ["one", "two"]);
  assert.deepEqual(killed.reused, []);
  assert.equal(killed.budgetUsed, 2);

  const resumed = simulateAttempt(dir, prompts);
  assert.deepEqual(
    resumed.reused,
    ["one", "two"],
    "settled calls cost nothing on resume",
  );
  assert.deepEqual(resumed.ran, ["three", "four", "five"]);
  assert.equal(resumed.budgetUsed, 5, "budget accumulates across attempts");

  // A third attempt has nothing left to do and charges nothing more.
  const again = simulateAttempt(dir, prompts);
  assert.deepEqual(again.ran, []);
  assert.equal(again.reused.length, 5);
  assert.equal(again.budgetUsed, 5);
});

test("repeated identical prompts are reused one-for-one", () => {
  const dir = runDir();
  const prompts = ["same", "same", "same"];

  simulateAttempt(dir, prompts, { stopAfter: 2 });
  const resumed = simulateAttempt(dir, prompts);

  assert.equal(resumed.reused.length, 2, "two of three were already recorded");
  assert.deepEqual(resumed.ran, ["same"]);
  assert.equal(resumed.budgetUsed, 3);
});

test("a moved worktree makes a resume redo the affected calls", () => {
  const dir = runDir();
  const prompts = ["one", "two", "three"];

  // These calls wrote: recorded before/after differ from the tree on resume.
  const writer = new LedgerWriter(dir);
  for (const [index, prompt] of prompts.slice(0, 2).entries()) {
    const inputHash = agentInputHash({ prompt });
    writer.append({
      ...entry({ inputHash, label: prompt }),
      key: ledgerKey(inputHash, 0),
      startedAt: index,
      finishedAt: index + 1,
      before: CLEAN,
      after: CLEAN_MOVED,
    });
  }

  const sameTree = simulateAttempt(dir, prompts, { worktree: CLEAN_MOVED });
  assert.deepEqual(sameTree.reused, ["one", "two"]);
  // That attempt also recorded "three", so the ledger now holds all three.
  assert.deepEqual(sameTree.ran, ["three"]);

  const movedTree = simulateAttempt(dir, prompts, { worktree: DIRTY });
  assert.deepEqual(movedTree.reused, [], "nothing survives a moved tree");
  assert.deepEqual(movedTree.ran, prompts);
  assert.deepEqual(
    movedTree.invalidated,
    ["worktree-moved", "after-invalidated", "after-invalidated"],
    "the first mismatch carries away everything recorded after it",
  );
});
