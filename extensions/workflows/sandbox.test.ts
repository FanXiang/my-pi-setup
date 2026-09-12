import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorkflowSandbox } from "./sandbox.ts";

function run(
  source: string,
  overrides: Partial<Parameters<typeof runWorkflowSandbox>[0]> = {},
) {
  const abort = new AbortController();
  return runWorkflowSandbox({
    source,
    args: undefined,
    cwd: process.cwd(),
    signal: abort.signal,
    onAgent: async (prompt) => ({ ok: true, output: `reply:${prompt}` }),
    onPhase: () => {},
    onAssume: () => {},
    onFlag: () => {},
    onReplan: () => {},
    onBlock: async () => undefined,
    ...overrides,
  });
}

test("sandbox exposes only workflow capabilities and validates results", async () => {
  const phases: string[] = [];
  const result = await run(
    `
      phase("Gather");
      const replies = await parallel([
        () => agent("one"),
        () => agent("two"),
      ], { concurrency: 99 });
      return {
        replies: replies.map((reply) => reply.output),
        processType: typeof process,
        requireType: typeof require,
        fetchType: typeof fetch,
      };
    `,
    { onPhase: (title) => phases.push(title) },
  );
  assert.deepEqual(result, {
    replies: ["reply:one", "reply:two"],
    processType: "undefined",
    requireType: "undefined",
    fetchType: "undefined",
  });
  assert.deepEqual(phases, ["Gather"]);
});

test("sandbox result serialization handles cycles and bigint", async () => {
  const result = await run(`
    const value = { count: 7n };
    value.self = value;
    return value;
  `);
  assert.deepEqual(result, { count: "7n", self: "[circular]" });
});

test("sandbox rejects unawaited agent calls", async () => {
  let calls = 0;
  await assert.rejects(
    run(`agent("orphan"); return "done";`, {
      onAgent: async () => {
        calls++;
        return { ok: true, output: "unexpected" };
      },
    }),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox source cannot escape the host accounting wrapper", async () => {
  let calls = 0;
  await assert.rejects(
    run(
      `}), agent("orphan"), Promise.resolve("bypass"); (async function () {`,
      {
        onAgent: async () => {
          calls++;
          return { ok: true, output: "unexpected" };
        },
      },
    ),
    /unawaited agent/,
  );
  assert.equal(calls, 0);
});

test("sandbox VM still rejects non-yielding synchronous code", async () => {
  await assert.rejects(run(`while (true) {}`), /timed out/);
});

test("workflow agent invocations have no per-request wall timer", async () => {
  let signalAborted = false;
  const result = await run(`return (await agent("delayed")).output;`, {
    onAgent: async (_prompt, _options, signal) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      signalAborted = signal.aborted;
      return { ok: true, output: "completed" };
    },
  });

  assert.equal(result, "completed");
  assert.equal(signalAborted, false);
});

test("workflow cancellation aborts a pending agent request", async () => {
  const controller = new AbortController();
  let startedResolve: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    startedResolve = resolve;
  });
  let requestAborted = false;
  const pending = run(`return await agent("pending");`, {
    signal: controller.signal,
    onAgent: async (_prompt, _options, signal) => {
      startedResolve?.();
      await new Promise<void>((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            requestAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      return { ok: false, output: "", error: "Agent was aborted" };
    },
  });

  await started;
  controller.abort(new Error("cancel fixture"));
  await assert.rejects(pending, /Workflow was aborted/);
  assert.equal(requestAborted, true);
});

test("escalation records reach the host with their payloads intact", async () => {
  const assumed: unknown[] = [];
  const flagged: unknown[] = [];
  const result = await run(
    `
      assume({ question: "Which timezone?", assumption: "UTC", reversible: true });
      flag({ note: "retry loop is untested" });
      flag("bare note");
      return "done";
    `,
    {
      onAssume: (input) => assumed.push(input),
      onFlag: (input) => flagged.push(input),
    },
  );

  assert.equal(result, "done");
  assert.deepEqual(assumed, [
    { question: "Which timezone?", assumption: "UTC", reversible: true },
  ]);
  assert.deepEqual(flagged, [{ note: "retry loop is untested" }, "bare note"]);
});

test("an answered block resolves inside the script and the run continues", async () => {
  const asked: unknown[] = [];
  const result = await run(
    `
      const answer = await block({
        decision: "Which account?",
        evidence: "two are configured",
        recommendation: "staging",
        choices: ["staging", "production"],
      });
      return "chose:" + answer.choice;
    `,
    {
      onBlock: async (input) => {
        asked.push(input);
        return { choice: "staging", answeredAt: 1 };
      },
    },
  );

  assert.equal(result, "chose:staging");
  assert.equal(asked.length, 1);
});

test("an unanswered block suspends the run instead of returning", async () => {
  const abort = new AbortController();
  // The host leaves the call unanswered and stops the run: that is the
  // suspension. The script never gets past the block, so the run rejects
  // instead of producing the result the source would have returned.
  await assert.rejects(
    runWorkflowSandbox({
      source: `
        await block({
          decision: "d",
          evidence: "e",
          recommendation: "r",
          choices: ["a"],
        });
        return "should not get here";
      `,
      args: undefined,
      cwd: process.cwd(),
      signal: abort.signal,
      onAgent: async () => ({ ok: true, output: "" }),
      onPhase: () => {},
      onAssume: () => {},
      onFlag: () => {},
      onReplan: () => {},
      onBlock: async () => {
        setTimeout(
          () => abort.abort(new Error("Workflow is awaiting input")),
          0,
        );
        return undefined;
      },
    }),
    /awaiting input|aborted/,
  );
});

test("replan reaches the host and does not need a reply", async () => {
  const abort = new AbortController();
  const replans: unknown[] = [];
  await assert.rejects(
    runWorkflowSandbox({
      source: `
        replan({ reason: "the spec contradicts itself" });
        await new Promise(() => {});
      `,
      args: undefined,
      cwd: process.cwd(),
      signal: abort.signal,
      onAgent: async () => ({ ok: true, output: "" }),
      onPhase: () => {},
      onAssume: () => {},
      onFlag: () => {},
      onReplan: (input) => {
        replans.push(input);
        abort.abort(new Error("Workflow requires replanning"));
      },
      onBlock: async () => undefined,
    }),
    /replanning|aborted/,
  );
  assert.deepEqual(replans, [{ reason: "the spec contradicts itself" }]);
});

test("a rejected escalation record fails the run rather than half-recording it", async () => {
  await assert.rejects(
    run(`assume({ question: "q" }); return "done";`, {
      onAssume: () => {
        throw new Error("assume() `assumption` is required");
      },
    }),
    /`assumption` is required/,
  );
});

test("escalation records are bounded and budgeted", async () => {
  // Far beyond the runaway guard: the run must fail, not fill the disk.
  await assert.rejects(
    run(
      `for (let i = 0; i < 500; i++) flag({ note: "n" + i }); return "done";`,
      { onFlag: () => {} },
    ),
    /record budget/,
  );
});
