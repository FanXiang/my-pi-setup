/**
 * Worktree probe for ledger entries.
 *
 * A ledger records what an agent *said*, not what it did to the filesystem.
 * That part is a real output and it is not in the ledger, so resuming a run
 * whose tree has moved underneath it would continue from an answer computed
 * against a different baseline — an error that produces wrong work without
 * ever reporting one. Recording the tree state around each call is what lets
 * the replay refuse such an entry.
 *
 * Probes never throw and never block the event loop: an unavailable git, a
 * non-repository directory, or a timeout all report `available: false`, which
 * the replay treats as "unknown, do not reuse".
 */

import { execFile } from "node:child_process";

const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_BUFFER = 1024 * 1024;

export interface WorktreeState {
  /** False when git could not answer; the replay then assumes the worst. */
  available: boolean;
  /** HEAD commit, absent for an empty repository. */
  sha?: string;
  /** True when `git status --porcelain` reported nothing. */
  clean: boolean;
}

export const UNKNOWN_WORKTREE: WorktreeState = {
  available: false,
  clean: false,
};

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

/**
 * Read HEAD and cleanliness. An empty repository reports `available: true`
 * with no `sha`, which is still usable: the replay compares both fields.
 */
export async function readWorktreeState(cwd: string): Promise<WorktreeState> {
  const status = await git(cwd, ["status", "--porcelain"]);
  if (status === undefined) return UNKNOWN_WORKTREE;
  const head = await git(cwd, ["rev-parse", "HEAD"]);
  const sha = head?.trim();
  return {
    available: true,
    ...(sha ? { sha } : {}),
    clean: status.trim().length === 0,
  };
}

/** True when both states are known and describe the same tree. */
export function worktreeMatches(
  recorded: WorktreeState | undefined,
  current: WorktreeState | undefined,
): boolean {
  if (!recorded?.available || !current?.available) return false;
  return recorded.sha === current.sha && recorded.clean === current.clean;
}

/**
 * Whether a call must be pinned to the tree it produced.
 *
 * Only a call provably free of effects escapes pinning: the tree was clean
 * before and after and HEAD did not move. Anything else — a moved HEAD, a
 * tree that became dirty, a tree that was already dirty, or a probe that
 * failed — is pinned, because none of those can be shown not to have written.
 * Being wrong here costs a re-run; being wrong the other way corrupts.
 */
export function callHadEffects(
  before: WorktreeState | undefined,
  after: WorktreeState | undefined,
): boolean {
  if (!before?.available || !after?.available) return true;
  if (before.sha !== after.sha) return true;
  return !before.clean || !after.clean;
}
