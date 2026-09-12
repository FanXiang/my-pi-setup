import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  callHadEffects,
  readWorktreeState,
  UNKNOWN_WORKTREE,
  worktreeMatches,
  type WorktreeState,
} from "./worktree.ts";

function emptyRepo() {
  const dir = mkdtempSync(path.join(tmpdir(), "wf-worktree-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: dir, stdio: "pipe" });
  run("init", "--quiet");
  run("config", "user.email", "test@example.com");
  run("config", "user.name", "Test");
  run("config", "commit.gpgsign", "false");
  return { dir, run };
}

function committedRepo() {
  const repo = emptyRepo();
  writeFileSync(path.join(repo.dir, "a.txt"), "one\n");
  repo.run("add", "a.txt");
  repo.run("commit", "--quiet", "-m", "first");
  return repo;
}

test("a clean repository reports its HEAD", async () => {
  const repo = committedRepo();
  const state = await readWorktreeState(repo.dir);
  assert.equal(state.available, true);
  assert.equal(state.clean, true);
  assert.match(state.sha ?? "", /^[0-9a-f]{40}$/);
});

test("an uncommitted edit is reported as dirty at the same HEAD", async () => {
  const repo = committedRepo();
  const before = await readWorktreeState(repo.dir);
  writeFileSync(path.join(repo.dir, "a.txt"), "two\n");
  const after = await readWorktreeState(repo.dir);

  assert.equal(after.clean, false);
  assert.equal(after.sha, before.sha);
  assert.equal(
    callHadEffects(before, after),
    true,
    "a dirtied tree is an effect",
  );
});

test("an untracked file counts as dirty", async () => {
  const repo = committedRepo();
  const before = await readWorktreeState(repo.dir);
  writeFileSync(path.join(repo.dir, "new.txt"), "new\n");
  const after = await readWorktreeState(repo.dir);
  assert.equal(after.clean, false);
  assert.equal(callHadEffects(before, after), true);
});

test("a commit moves HEAD and stays clean", async () => {
  const repo = committedRepo();
  const before = await readWorktreeState(repo.dir);
  writeFileSync(path.join(repo.dir, "b.txt"), "two\n");
  repo.run("add", "b.txt");
  repo.run("commit", "--quiet", "-m", "second");
  const after = await readWorktreeState(repo.dir);

  assert.equal(after.clean, true);
  assert.notEqual(after.sha, before.sha);
  assert.equal(callHadEffects(before, after), true);
  assert.equal(worktreeMatches(after, before), false);
  assert.equal(worktreeMatches(after, after), true);
});

test("an empty repository is available but has no HEAD", async () => {
  const repo = emptyRepo();
  const state = await readWorktreeState(repo.dir);
  assert.equal(state.available, true);
  assert.equal(state.sha, undefined);
  assert.equal(state.clean, true);
});

test("a directory outside any repository is unavailable, not clean", async () => {
  const outside = mkdtempSync(path.join(tmpdir(), "wf-not-a-repo-"));
  const state = await readWorktreeState(outside);
  assert.equal(state.available, false);
  assert.equal(
    state.clean,
    false,
    "an unknown tree must not look like a clean one",
  );
});

test("a missing directory is reported as unavailable rather than throwing", async () => {
  const state = await readWorktreeState(
    path.join(tmpdir(), "wf-definitely-missing-dir-12345"),
  );
  assert.deepEqual(state, UNKNOWN_WORKTREE);
});

test("an unchanged clean tree is the only case free of effects", () => {
  const clean: WorktreeState = { available: true, sha: "aaa", clean: true };
  assert.equal(callHadEffects(clean, clean), false);

  // Every other combination is pinned, because none can be shown not to write.
  const dirty: WorktreeState = { available: true, sha: "aaa", clean: false };
  assert.equal(
    callHadEffects(dirty, dirty),
    true,
    "already dirty proves nothing",
  );
  assert.equal(callHadEffects(UNKNOWN_WORKTREE, clean), true);
  assert.equal(callHadEffects(clean, UNKNOWN_WORKTREE), true);
  assert.equal(callHadEffects(undefined, clean), true);
  assert.equal(callHadEffects(clean, undefined), true);
});

test("matching requires both sides to be known", () => {
  const clean: WorktreeState = { available: true, sha: "aaa", clean: true };
  assert.equal(worktreeMatches(clean, { ...clean }), true);
  assert.equal(worktreeMatches(clean, { ...clean, clean: false }), false);
  assert.equal(worktreeMatches(clean, { ...clean, sha: "bbb" }), false);
  assert.equal(worktreeMatches(clean, UNKNOWN_WORKTREE), false);
  assert.equal(worktreeMatches(UNKNOWN_WORKTREE, clean), false);
  assert.equal(worktreeMatches(undefined, clean), false);
  assert.equal(worktreeMatches(clean, undefined), false);
});
