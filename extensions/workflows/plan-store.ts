/**
 * Where plans live between being written and being run.
 *
 * A plan outlives the tool call that produced it - it is reviewed, approved,
 * and only then run, possibly in a later session - so it has to be on disk
 * rather than in a session's memory. Plans sit beside runs under the agent
 * directory, and a run records the plan it froze rather than pointing at this
 * copy, so editing a stored plan can never change what a run in flight is
 * doing.
 *
 * Everything read back goes through `normalizePlanInput` again. It is our own
 * file, but a file is a thing a person can edit, and the cost of re-parsing is
 * nothing next to the cost of a malformed plan reaching the scheduler.
 */

import { readFileSync, readdirSync } from "node:fs";
import * as path from "node:path";
import { normalizePlanInput, type Plan } from "./plan.ts";
import { writeFileAtomic } from "./serialization.ts";

export const PLANS_DIR = "plans";

export function plansDir(workflowsDir: string): string {
  return path.join(workflowsDir, PLANS_DIR);
}

export function planPath(workflowsDir: string, planId: string): string {
  return path.join(plansDir(workflowsDir), `${planId}.json`);
}

export function writePlan(workflowsDir: string, plan: Plan): string {
  const file = planPath(workflowsDir, plan.planId);
  // Indented: a plan is meant to be read and diffed by a person before they
  // approve it, which is the entire point of it being data.
  writeFileAtomic(file, `${JSON.stringify(plan, null, 2)}\n`);
  return file;
}

export function readPlan(
  workflowsDir: string,
  planId: string,
): Plan | undefined {
  try {
    const raw = readFileSync(planPath(workflowsDir, planId), "utf8");
    return normalizePlanInput(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

export function listPlans(workflowsDir: string): Plan[] {
  let entries: string[];
  try {
    entries = readdirSync(plansDir(workflowsDir));
  } catch {
    return [];
  }
  const plans: Plan[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const plan = readPlan(workflowsDir, entry.slice(0, -".json".length));
    // A plan that no longer parses is skipped rather than thrown over: one
    // corrupt file should not make the whole list unreadable.
    if (plan) plans.push(plan);
  }
  return plans;
}
