import { describeBlocker } from "./escalation.ts";
import {
  countStates,
  formatElapsed,
  resultJson,
  shortenHome,
  type WorkflowDetails,
} from "./model.ts";

/** Model-facing schema descriptions for workflow source, arguments, and background mode. */
export const WORKFLOW_PARAMETER_DESCRIPTIONS = {
  script:
    "JavaScript workflow script. May start with `export const meta = {...}`, then use phase(), agent(), parallel(), args, and a final `return`.",
  args: "Optional JSON string exposed to the script as `args` (parsed when valid JSON, otherwise passed through as the raw string).",
  background:
    "Run in the background: the tool returns a run id immediately and you receive a follow-up message when the workflow finishes. Defaults to false (blocking with live progress).",
  answerRunId: "Run id of the suspended workflow to answer.",
  answerBlockerId:
    "Blocker id from the workflow's Attention Request (also shown in the run's NEEDS-INPUT.md).",
  answerChoice:
    "The decision, which must be one of the blocker's listed choices.",
  answerNote: "Optional reasoning or extra context to record with the answer.",
  planPlan:
    "The plan, as a JSON object (or a JSON string). Shape: { workItemId, task: { title, statement, cwd, branch? }, provider: { id, version, catalogHash }, budget: { agentCalls, concurrency }, policy: { blockable, maxEscalation, onGateFail, notify? }, steps: [...] }. Each step: { id, kind: inline|serial|fanout|script, mode: HITL|AFK, procedure, label, blockedBy: [stepId], brief, escalation: 1|2|3, effects: readonly|worktree|repo, gate?, budget?, fanout? }. An AFK step needs a gate: { schema, predicates: [{ path, op, value?, message? }], verify?: { script } } where op is one of exists, nonEmpty, minLength, maxLength, eq, ne, matches, everyNonEmpty, and `verify.script` names a script the repo\'s package.json already declares.",
  planMode:
    'Which kind of run to validate for: "foreground" (default) or "detached". Detached is stricter - it refuses inline and HITL steps, requires the plan to be approved, and requires a notify channel if the run may stop for a person.',
  resume:
    "Run id of a previous run to continue. Pass the same `script` and `args`: every agent call that already settled is answered from that run's ledger instead of being paid for again, and only unfinished or invalidated work runs. A script that does not match the recorded one is rejected rather than resumed.",
};

/** Defines the workflow DSL, constraints, reliability guidance, and model-authored task examples. */
export const WORKFLOW_TOOL_DESCRIPTION = [
  "The workflow tool is only to be called when the user says 'ultracode' or specifically requests a workflow run.",
  "Run a multi-agent workflow from a JavaScript orchestration script you write inline. Use this when a task benefits from fanning work out across several isolated subagents in ordered phases (research fan-out, per-file review, verify-then-synthesize pipelines).",
  "The script runs as an async function body with these primitives:",
  "• export const meta = { name, description, phases: [{ title, detail? }] } — metadata for the progress UI. Declare all phases up front.",
  "• phase(title) — mark the current phase at runtime (use titles from meta.phases).",
  "• await agent(prompt, { label?, phase?, schema?, model?, provider?, effort? }) — run ONE subagent in an isolated context and wait for it. Always resolves to { ok, output, structured?, error? }. Check `ok` before using the result. When you pass a JSON `schema`, `structured` holds the validated object on success. `model`/`provider` override the session model; `effort` sets the thinking level (off|minimal|low|medium|high|xhigh|max). Children receive normal built-ins and trust-appropriate extensions, settings, skills, and AGENTS.md context, but cannot recursively orchestrate or ask the user.",
  "• await parallel([() => agent(...), () => agent(...)], { concurrency? }) — run zero-argument agent thunks concurrently and return results in order. Concurrency is globally capped at 4 for the run.",
  "• args — the parsed value of the `args` tool parameter (or undefined).",
  "• assume({ question, assumption, evidence?, reversible?, step? }) — record what you proceeded on instead of asking, and keep going. This is the normal move for an implementation judgement call: do not stop the run for it.",
  "• flag({ note, evidence?, step? }) — record something the reader must see, without stopping. Review findings belong here.",
  "• await block({ decision, evidence, recommendation, choices: [...], step? }) — stop and wait for a person. Only for a fact you cannot obtain, an action only a human can take, or a decision whose branches each lose something. The run suspends; when the person answers, a resumed run gets { choice, note } from this call and carries on. `recommendation` and `choices` are required: hand over a decision, not a question.",
  "• replan({ reason, conflictingEvidence?, suggestedClarifications: [...] }) — end the run because the plan itself is wrong (the spec contradicts itself, the task was misunderstood). Use this instead of block() when no answer would fix it.",
  "Workflow JavaScript runs in a restricted, killable child with no imports, eval, timers, filesystem, network, or process APIs. A run may make at most 32 agent calls and has no overall deadline. Each agent must receive its first assistant response event within 45 seconds so silent provider requests fail clearly; after that, agent() has no wall-clock deadline. Each individual child tool call times out independently after 3 minutes, becomes an error tool result, and leaves the agent loop free to recover. Use map/filter/if/await/template strings to orchestrate, and `return` a JSON-serializable aggregate.",
  "Pass a `schema` to agent() whenever a later step branches on the result, so you get typed fields instead of prose. A failed or interrupted run can be continued with the `resume` parameter: settled agent calls are answered from the run's ledger, so only the unfinished work costs anything. Artifacts are saved under ~/.pi/agent/workflows/<runId>/ for inspection.",
  "Example:",
  "export const meta = { name: 'reliability-review', description: 'Review modules for reliability risks, then report', phases: [{ title: 'Scan' }, { title: 'Report' }] }",
  "const FINDINGS = { type: 'object', properties: { issues: { type: 'array', items: { type: 'string' } }, ok: { type: 'boolean' } }, required: ['issues', 'ok'] }",
  "phase('Scan')",
  "const scans = await parallel(args.files.map((f) => () => agent(`Review ${f} for correctness and reliability risks.`, { label: `scan:${f}`, phase: 'Scan', schema: FINDINGS })))",
  "const findings = scans.filter((r) => r.ok).map((r) => r.structured)",
  "phase('Report')",
  "const report = await agent(`Summarize these findings: ${JSON.stringify(findings)}`, { label: 'report', phase: 'Report' })",
  "return { findings, report: report.ok ? report.output : report.error }",
].join("\n");

/** Adds workflow orchestration primitives and background execution to the model's tool prompt. */
export const WORKFLOW_PROMPT_SNIPPET =
  "Orchestrate isolated subagents from an inline JS script: phase()/agent()/parallel() with structured outputs and optional background execution";

/** Model-facing description of the answer tool. */
export const WORKFLOW_ANSWER_TOOL_DESCRIPTION = [
  "Answer an Attention Request from a suspended workflow run, then resume that run to continue past it.",
  "Use this when a workflow reports it is awaiting input. The choice must be one of the blocker's listed choices; the answer is recorded durably, so resuming replays the run and the blocking call returns your answer instead of stopping again.",
].join("\n");

/** Model-facing description of the planning tool. */
export const WORKFLOW_PLAN_TOOL_DESCRIPTION = [
  "Compose a workflow plan for the current task and check it against the admission rules. This never executes anything.",
  "A plan is data, not code: a DAG of steps, each naming a procedure from an installed methodology provider, each with a brief that is the whole of what its agent will be told. Write it from the provider's procedure list; the rules below are what make it safe to run, not your confidence in it.",
  "The plan is checked by V1-V10: the procedure exists (V1) and each edge is a legal transition (V2); the graph is a connected DAG (V3); every unattended step has a gate (V4); escalation fits the policy (V5); budgets add up (V6); a detached run has no step needing the session (V7); repo-writing steps cannot collide (V8); a detached run matches the plan that was approved (V9) and can reach a person if it may stop (V10).",
  "Every problem is reported at once. Fix them and call again - calling again unchanged will fail again in the same way.",
  "A plan that passes is stored and returned with its planId and planHash. It is not approved and not running: approval is the user's, and it freezes that exact hash.",
].join("\n");

/** Guides the model on appropriate workflow fan-out and mandatory agent result checks. */
export const WORKFLOW_PROMPT_GUIDELINES = [
  "Use workflow when a task needs several subagents with phase dependencies or dynamic fan-out; keep single small delegations in the main session.",
  "In workflow scripts, agent() never throws — always check `.ok` on its result before using `.output`/`.structured`.",
  "A workflow never asks the user mid-run: record an assumption with assume(), surface a finding with flag(), and reserve block() for a decision nobody in the run can make.",
];

/** Marks and forwards a workflow script's agent() task as an isolated child-model prompt. */
export function buildWorkflowAgentPrompt(prompt: string) {
  return prompt;
}

/** Instructs structured workflow children to terminate with exactly one structured_output call. */
export const STRUCTURED_OUTPUT_SYSTEM_INSTRUCTION =
  "When your task is complete, call the `structured_output` tool exactly once as your final action, with fields matching the required schema. Do not write any other text after it.";

/** Describes the terminating structured_output tool and its final-action contract. */
export const STRUCTURED_OUTPUT_TOOL_DESCRIPTION =
  "Return your final result as structured data matching the required schema. Call this exactly once, as your last action; do not write any other text after it.";

/** Builds the workflow completion report returned to the parent model. */
export function buildWorkflowResultMessage(
  details: WorkflowDetails,
  runDir: string,
) {
  const { done, failed } = countStates(details);
  const elapsed = formatElapsed(details.startedAt, details.finishedAt);
  const reused = details.agents.filter((agent) => agent.reused).length;
  const lines = [
    `Workflow ${details.name ? `"${details.name}"` : details.runId} ${details.status} — ` +
      `${done}/${details.agents.length} agents ok${failed ? `, ${failed} failed` : ""}` +
      `${reused ? `, ${reused} reused from the ledger` : ""} ` +
      `across ${details.phases.length} phase(s) in ${elapsed}.`,
    `Run dir: ${shortenHome(runDir)}`,
  ];
  if ((details.attempt ?? 1) > 1) {
    lines.push(
      `Attempt ${details.attempt} (resumed); ${details.budgetUsed ?? 0} agent call(s) charged in total.`,
    );
  }
  if (details.blocker) {
    lines.push(
      "",
      describeBlocker(details.blocker, details.runId),
      "",
      `Resume with: workflow resume=${details.runId} (same script and args) once the blocker is answered.`,
    );
  }
  if (details.replan) {
    lines.push(
      "",
      `Replanning needed: ${details.replan.reason}`,
      ...(details.replan.conflictingEvidence
        ? [`Conflicting evidence: ${details.replan.conflictingEvidence}`]
        : []),
      ...(details.replan.suggestedClarifications.length > 0
        ? [
            "Suggested clarifications:",
            ...details.replan.suggestedClarifications.map(
              (item) => `  - ${item}`,
            ),
          ]
        : []),
    );
  }
  const assumptions = details.assumptions ?? [];
  if (assumptions.length > 0) {
    // Irreversible assumptions first: those are the ones that matter if wrong.
    const ordered = [...assumptions].sort(
      (a, b) => Number(a.reversible) - Number(b.reversible),
    );
    lines.push("", `Assumptions (${assumptions.length}):`);
    for (const assumption of ordered) {
      lines.push(
        `- ${assumption.reversible ? "" : "[irreversible] "}${assumption.question} → ${assumption.assumption}`,
      );
    }
  }
  const flags = details.flags ?? [];
  if (flags.length > 0) {
    lines.push("", `Flags (${flags.length}):`);
    for (const flag of flags) lines.push(`- ${flag.note}`);
  }
  if (details.replay && details.replay.invalidated > 0) {
    lines.push(
      `${details.replay.invalidated} recorded call(s) were invalidated because the worktree moved, and ran again.`,
    );
  }
  if (details.error) lines.push(`Error: ${details.error}`);
  if (details.agents.length > 0) {
    lines.push("", "Agents:");
    for (const agent of details.agents) {
      const status =
        agent.state === "done"
          ? "ok"
          : agent.state === "error"
            ? "FAILED"
            : "running";
      lines.push(
        `- [${agent.label}]${agent.phase ? ` (${agent.phase})` : ""} ${status}` +
          (agent.error ? ` — ${agent.error}` : ""),
      );
    }
  }
  if (details.result !== undefined)
    lines.push("", "Result:", resultJson(details.result));
  return lines.join("\n");
}

/** Builds the follow-up user message that delivers a settled background workflow to the parent model. */
export function buildBackgroundWorkflowFollowUp(options: {
  runId: string;
  status: WorkflowDetails["status"];
  result: string;
}) {
  return `[Background workflow ${options.runId} ${options.status}]\n\n${options.result}`;
}

/** Builds the background-launch result and tells the parent model where progress and artifacts appear. */
export function buildBackgroundWorkflowLaunchResult(options: {
  runId: string;
  name?: string;
  runDir: string;
}) {
  return [
    `Workflow ${options.name ? `"${options.name}"` : options.runId} launched in background (run ${options.runId}).`,
    `Artifacts: ${shortenHome(options.runDir)}`,
    "You'll receive a follow-up message when it finishes; /workflows shows progress.",
  ].join("\n");
}
