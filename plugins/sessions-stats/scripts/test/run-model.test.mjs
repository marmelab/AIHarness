// Tests for the derivation every chart is drawn from.
//
// The three attribution rules stated at the top of run-model.mjs are the ones pinned here,
// because each has a plausible wrong version that produces a chart nobody can tell is
// wrong: summing overlapping tool calls, summing a streamed response's usage once per
// content block, and charging a resumed session's overnight gap as working time.

import { describe, expect, test } from "vitest";
import { makeClassifier } from "../lib/activity.mjs";
import {
  activeSpans,
  buildAgent,
  CALL_CAP_MS,
  CHARS_PER_OUTPUT_TOKEN,
  buildRun,
  commonPrefixRatio,
  detectLoops,
  detectRedispatches,
  IDLE_CAP_MS,
  mergeSpans,
  parseHookLine,
  parseTranscript,
  rollupActivities,
  hookEvents,
  rollupHookRuns,
  rollupHooks,
  sessionTitle,
  splitGaps,
  STALL_MS,
} from "../lib/run-model.mjs";

const attachment = (ms, a) =>
  JSON.stringify({ type: "attachment", timestamp: at(ms), attachment: a });

const classify = makeClassifier();
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

const usage = (over = {}) => ({
  input_tokens: 0,
  output_tokens: 10,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 0,
  ...over,
});

/** One assistant entry. Several entries may share `id`, as a streamed response does. */
const assistant = (ms, id, content, over = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ms),
    message: { id, model: "claude-sonnet-5", usage: usage(over), content },
  });

const toolUse = (id, name, input) => ({ type: "tool_use", id, name, input });

const result = (ms, toolUseId, over = {}) =>
  JSON.stringify({
    type: "user",
    timestamp: at(ms),
    message: {
      content: [
        { type: "tool_result", tool_use_id: toolUseId, content: "ok", ...over },
      ],
    },
  });

describe("mergeSpans", () => {
  test("overlapping spans count once", () => {
    expect(
      mergeSpans([
        [0, 100],
        [50, 150],
      ]),
    ).toBe(150);
  });

  test("disjoint spans add up", () => {
    expect(
      mergeSpans([
        [0, 100],
        [200, 250],
      ]),
    ).toBe(150);
  });

  test("garbage decides nothing", () => {
    expect(mergeSpans([[NaN, 10], [10, 5], []])).toBe(0);
  });
});

describe("parseTranscript", () => {
  test("a streamed response is ONE turn and its context is counted once", () => {
    // The same message.id arrives on several lines with the SAME usage. Summing per line
    // would multiply the context by the number of content blocks, which is the single
    // easiest way to produce a cost chart that is confidently wrong.
    const body = [
      assistant(0, "msg-1", [{ type: "text", text: "hi" }]),
      assistant(100, "msg-1", [toolUse("t1", "Read", { file_path: "/a.ts" })]),
      result(600, "t1"),
    ].join("\n");
    const { turns } = parseTranscript(body, classify);
    expect(turns).toHaveLength(1);
    expect(turns[0].ctx).toBe(1000);
  });

  test("a response with no final usage is charged at least what it visibly wrote", () => {
    // A subagent transcript keeps the first chunk's usage: no stop_reason, 4 output tokens
    // on a response that thought for 4000 characters and wrote a 2000-character edit.
    const edit = {
      file_path: "/a.ts",
      old_string: "x",
      new_string: "y".repeat(2000),
    };
    const body = [
      assistant(
        0,
        "msg-1",
        [{ type: "thinking", thinking: "t".repeat(4000) }],
        {
          output_tokens: 4,
        },
      ),
      assistant(100, "msg-1", [toolUse("t1", "Edit", edit)], {
        output_tokens: 4,
      }),
      result(600, "t1"),
    ].join("\n");
    const { turns } = parseTranscript(body, classify);
    const chars = 4000 + "Edit".length + JSON.stringify(edit).length;
    expect(turns[0].out).toBe(Math.ceil(chars / CHARS_PER_OUTPUT_TOKEN));
  });

  test("a response with a stop_reason keeps its recorded output", () => {
    const line = JSON.parse(
      assistant(0, "msg-1", [{ type: "text", text: "w".repeat(4000) }], {
        output_tokens: 40,
      }),
    );
    line.message.stop_reason = "end_turn";
    const { turns } = parseTranscript(JSON.stringify(line), classify);
    expect(turns[0].out).toBe(40);
  });

  test("a call runs from its tool_use to its tool_result", () => {
    const body = [
      assistant(0, "msg-1", [toolUse("t1", "Read", { file_path: "/a.ts" })]),
      result(2000, "t1"),
    ].join("\n");
    const { calls } = parseTranscript(body, classify);
    expect(calls[0].durationMs).toBe(2000);
    expect(calls[0].activity).toBe("explore");
    expect(calls[0].answered).toBe(true);
  });

  test("a call with no result is kept, at zero duration rather than dropped", () => {
    // An interrupted run ends mid-call. Dropping it would under-count the work attempted.
    const body = assistant(0, "msg-1", [
      toolUse("t1", "Bash", { command: "npm test" }),
    ]);
    const { calls } = parseTranscript(body, classify);
    expect(calls).toHaveLength(1);
    expect(calls[0].answered).toBe(false);
    expect(calls[0].durationMs).toBe(0);
  });

  test("an errored result is flagged", () => {
    const body = [
      assistant(0, "msg-1", [
        toolUse("t1", "Bash", { command: "npm run build" }),
      ]),
      result(500, "t1", { is_error: true }),
    ].join("\n");
    const { calls } = parseTranscript(body, classify);
    expect(calls[0].isError).toBe(true);
  });

  test("a turn takes the activity most of its calls belong to", () => {
    const body = [
      assistant(0, "msg-1", [
        toolUse("t1", "Read", { file_path: "/a.ts" }),
        toolUse("t2", "Read", { file_path: "/b.ts" }),
        toolUse("t3", "Edit", { file_path: "/c.ts" }),
      ]),
      result(100, "t1"),
      result(100, "t2"),
      result(100, "t3"),
    ].join("\n");
    const { turns } = parseTranscript(body, classify);
    expect(turns[0].activity).toBe("explore");
  });

  test("a turn with no call at all is `think`", () => {
    const { turns } = parseTranscript(
      assistant(0, "msg-1", [{ type: "text", text: "." }]),
      classify,
    );
    expect(turns[0].activity).toBe("think");
  });

  test("the gap before a turn is its wait", () => {
    const body = [
      assistant(0, "msg-1", [toolUse("t1", "Read", { file_path: "/a.ts" })]),
      result(1000, "t1"),
      assistant(9000, "msg-2", [{ type: "text", text: "done" }]),
    ].join("\n");
    const { turns } = parseTranscript(body, classify);
    expect(turns[0].waitMs).toBe(0);
    expect(turns[1].waitMs).toBe(8000);
  });
});

describe("rollupActivities", () => {
  test("parallel calls in one turn are merged, not summed", () => {
    // Two 10s reads fired together cost 10 wall-clock seconds. `durationMs` sums to 20 and
    // `wallMs` must not: a Gantt drawn from the sum would show an agent working longer than
    // the session lasted.
    const body = [
      assistant(0, "msg-1", [
        toolUse("t1", "Read", { file_path: "/a.ts" }),
        toolUse("t2", "Read", { file_path: "/b.ts" }),
      ]),
      result(10000, "t1"),
      result(10000, "t2"),
    ].join("\n");
    const { turns, calls } = parseTranscript(body, classify);
    const explore = rollupActivities(turns, calls).find(
      (r) => r.activity === "explore",
    );
    expect(explore.durationMs).toBe(20000);
    expect(explore.wallMs).toBe(10000);
  });

  test("a long gap is idle WHOLE, never part generation", () => {
    // Charging its first five minutes to `wait` counted the opening of every stall twice:
    // once as generation here, once as an incident at run level. Measured on two real
    // sessions, 57% and 58% of the wait bucket was that overlap, and the wait-per-minute
    // headline built on it was inflated by the same amount.
    const gap = IDLE_CAP_MS + 60 * 60 * 1000;
    const body = [
      assistant(0, "msg-1", [toolUse("t1", "Read", { file_path: "/a.ts" })]),
      result(1000, "t1"),
      assistant(1000 + gap, "msg-2", [{ type: "text", text: "back" }]),
    ].join("\n");
    const { turns, calls } = parseTranscript(body, classify);
    const rows = rollupActivities(turns, calls);
    expect(rows.find((r) => r.activity === "wait")).toBe(undefined);
    expect(rows.find((r) => r.activity === "idle").wallMs).toBe(gap);
  });

  test("a short gap is generation, whole", () => {
    const gap = IDLE_CAP_MS - 1000;
    const body = [
      assistant(0, "msg-1", [toolUse("t1", "Read", { file_path: "/a.ts" })]),
      result(1000, "t1"),
      assistant(1000 + gap, "msg-2", [{ type: "text", text: "back" }]),
    ].join("\n");
    const { turns, calls } = parseTranscript(body, classify);
    const rows = rollupActivities(turns, calls);
    expect(rows.find((r) => r.activity === "wait").wallMs).toBe(gap);
    expect(rows.find((r) => r.activity === "idle")).toBe(undefined);
  });
});

describe("a stalled call", () => {
  // A call's duration is result-minus-request, which stops being work the moment a session
  // is interrupted: one `curl -m 2` in the archive reports 6296 seconds. The raw value is
  // kept, because it is what makes the interruption findable; the CHARGED value is capped,
  // because it is what every chart adds up.
  const stalled = () => {
    const body = [
      assistant(0, "msg-1", [
        toolUse("t1", "Bash", {
          command: "curl -s -m 2 http://localhost:3098/",
        }),
      ]),
      result(CALL_CAP_MS * 3, "t1", { is_error: true }),
    ].join("\n");
    return parseTranscript(body, classify);
  };

  test("keeps its real duration and charges only the cap", () => {
    const { calls } = stalled();
    expect(calls[0].durationMs).toBe(CALL_CAP_MS * 3);
    expect(calls[0].chargedMs).toBe(CALL_CAP_MS);
    expect(calls[0].stalled).toBe(true);
  });

  test("cannot stretch its activity over the whole interruption", () => {
    const { turns, calls } = stalled();
    const row = rollupActivities(turns, calls).find(
      (r) => r.activity === "runtime",
    );
    expect(row.wallMs).toBe(CALL_CAP_MS);
    expect(row.stalled).toBe(1);
  });

  test("an ordinary long call is not flagged", () => {
    const body = [
      assistant(0, "msg-1", [toolUse("t1", "Bash", { command: "npm test" })]),
      result(60000, "t1"),
    ].join("\n");
    const { calls } = parseTranscript(body, classify);
    expect(calls[0].stalled).toBe(false);
    expect(calls[0].chargedMs).toBe(60000);
  });
});

describe("activeSpans", () => {
  test("a gap long enough to be a stall buys no active time at all", () => {
    const spans = activeSpans([
      { start: 1_000_000, end: 1_000_500, waitMs: IDLE_CAP_MS * 3 },
    ]);
    expect(mergeSpans(spans)).toBe(500);
  });

  test("a short gap is charged in full", () => {
    const spans = activeSpans([
      { start: 1_000_000, end: 1_000_500, waitMs: 30_000 },
    ]);
    expect(mergeSpans(spans)).toBe(30_500);
  });
});

describe("detectLoops", () => {
  const call = (over) => ({
    turnIdx: 0,
    tool: "Read",
    activity: "explore",
    detail: "/a.ts",
    path: "/a.ts",
    signature: "Read\u0000/a.ts",
    durationMs: 1000,
    chargedMs: 1000,
    stalled: false,
    isError: false,
    ...over,
  });

  test("the same call twice is a repeat, and only the repeats count as waste", () => {
    const [loop] = detectLoops([call({}), call({ turnIdx: 4 })]);
    expect(loop.kind).toBe("repeat-call");
    expect(loop.count).toBe(2);
    expect(loop.wastedMs).toBe(1000);
  });

  test("a third read of one file is a re-read", () => {
    const loops = detectLoops([
      call({ signature: "s1" }),
      call({ signature: "s2" }),
      call({ signature: "s3" }),
    ]);
    expect(loops.some((l) => l.kind === "reread")).toBe(true);
  });

  test("two reads of one file are not a re-read", () => {
    const loops = detectLoops([
      call({ signature: "s1" }),
      call({ signature: "s2" }),
    ]);
    expect(loops.some((l) => l.kind === "reread")).toBe(false);
  });

  test("a repeated dispatch is reported as a dispatch, not as a repeated call", () => {
    const dispatch = call({
      tool: "Agent",
      activity: "dispatch",
      path: null,
      signature: "Agent\u0000developer\u0000fix login",
      detail: "developer: fix login",
    });
    const [loop] = detectLoops([dispatch, { ...dispatch, turnIdx: 9 }]);
    expect(loop.kind).toBe("duplicate-dispatch");
  });

  test("a failure followed by a near-identical retry is an error-retry", () => {
    const failed = call({
      tool: "Bash",
      activity: "exec",
      path: null,
      detail: "npm run build --workspace app",
      signature: "b1",
      isError: true,
    });
    const retried = call({
      tool: "Bash",
      activity: "exec",
      path: null,
      detail: "npm run build --workspace api",
      signature: "b2",
      turnIdx: 1,
    });
    const loops = detectLoops([failed, retried]);
    expect(loops.some((l) => l.kind === "error-retry")).toBe(true);
  });
});

describe("detectRedispatches", () => {
  test("the same role asked for the same thing again is a redispatch", () => {
    const agents = [
      {
        agentId: "a",
        role: "developer",
        description: "implement the filter",
        startedAt: 1,
        durationMs: 60000,
        usd: 1,
      },
      {
        agentId: "b",
        role: "developer",
        description: "implement the filters",
        startedAt: 2,
        durationMs: 60000,
        usd: 1,
      },
    ];
    expect(detectRedispatches(agents)).toHaveLength(1);
  });

  test("two different tickets are not a redispatch", () => {
    const agents = [
      {
        agentId: "a",
        role: "developer",
        description: "add the company column",
        startedAt: 1,
        durationMs: 1,
        usd: 0,
      },
      {
        agentId: "b",
        role: "developer",
        description: "rewrite the export pipeline",
        startedAt: 2,
        durationMs: 1,
        usd: 0,
      },
    ];
    expect(detectRedispatches(agents)).toEqual([]);
  });

  test("the same description from a different role is not a redispatch", () => {
    const agents = [
      {
        agentId: "a",
        role: "developer",
        description: "the login fix",
        startedAt: 1,
        durationMs: 1,
        usd: 0,
      },
      {
        agentId: "b",
        role: "quality-reviewer",
        description: "the login fix",
        startedAt: 2,
        durationMs: 1,
        usd: 0,
      },
    ];
    expect(detectRedispatches(agents)).toEqual([]);
  });
});

describe("commonPrefixRatio", () => {
  test("identical is 1 and disjoint is 0", () => {
    expect(commonPrefixRatio("abc", "abc")).toBe(1);
    expect(commonPrefixRatio("abc", "xyz")).toBe(0);
    expect(commonPrefixRatio("", "")).toBe(1);
  });
});

describe("hooks.log", () => {
  test("the grammar hooks/lib/context.mjs writes is what is parsed", () => {
    const line = "[2026-09-01T10:00:00.000Z] [bash-guard] BLOCKED npm run e2e";
    expect(parseHookLine(line)).toMatchObject({ hook: "bash-guard" });
  });

  test("a line that is not that grammar is skipped, not guessed at", () => {
    expect(parseHookLine("some raw compiler output")).toBe(null);
  });

  test("a refusal is counted apart from ordinary chatter", () => {
    const [row] = rollupHooks(
      [
        "[2026-09-01T10:00:00.000Z] [bash-guard] checking",
        "[2026-09-01T10:00:01.000Z] [bash-guard] BLOCKED npm run e2e",
      ].join("\n"),
    );
    expect(row).toMatchObject({ hook: "bash-guard", lines: 2, blocks: 1 });
  });
});

describe("buildAgent", () => {
  test("reports the starting context, not only the final one", () => {
    const body = [
      assistant(0, "msg-1", [toolUse("t1", "Read", { file_path: "/a.ts" })], {
        cache_read_input_tokens: 20000,
      }),
      result(100, "t1"),
      assistant(1000, "msg-2", [{ type: "text", text: "done" }], {
        cache_read_input_tokens: 45000,
      }),
    ].join("\n");
    const agent = buildAgent({ agentId: "a1", body, classify });
    expect(agent.ctxFirst).toBe(20000);
    expect(agent.ctxLast).toBe(45000);
    expect(agent.thinkTurns).toBe(1);
    expect(agent.toolTurns).toBe(1);
  });

  test("the plugin prefix is packaging, not identity", () => {
    const agent = buildAgent({
      agentId: "a1",
      body: assistant(0, "m", [{ type: "text", text: "." }]),
      meta: { agentType: "aiharness:quality-reviewer" },
      classify,
    });
    expect(agent.role).toBe("quality-reviewer");
  });
});

describe("buildRun", () => {
  const body = [
    assistant(0, "msg-1", [toolUse("t1", "Read", { file_path: "/a.ts" })]),
    result(1000, "t1"),
  ].join("\n");

  test("folds the main thread and its subagents into one run", () => {
    const run = buildRun({
      sessionId: "s1",
      slug: "-p",
      mainBody: body,
      agents: [
        {
          agentId: "agent-1",
          body,
          meta: { agentType: "aiharness:developer" },
        },
      ],
      classify,
    });
    expect(run.agents.map((a) => a.role)).toEqual(["main", "developer"]);
    expect(run.turnCount).toBe(2);
    expect(run.hasHooksLog).toBe(false);
  });

  test("an agent a forked skill started is named after the skill", () => {
    const lane = [
      assistant(0, "msg-1", [
        toolUse("s1", "Skill", { skill: "code-review", args: "high a..b" }),
      ]),
      result(9000, "s1"),
    ].join("\n");
    const fork = [
      assistant(2000, "msg-2", [toolUse("t1", "Read", { file_path: "/a.ts" })]),
      result(3000, "t1"),
    ].join("\n");
    const run = buildRun({
      sessionId: "s1",
      slug: "-p",
      agents: [
        {
          agentId: "agent-lane1",
          body: lane,
          meta: { agentType: "reviewer", toolUseId: "toolu_x" },
        },
        {
          agentId: "agent-fork1",
          body: fork,
          meta: { agentType: "general-purpose", parentAgentId: "lane1" },
        },
        // A general-purpose agent that an Agent call started stays what it is.
        {
          agentId: "agent-dev1",
          body,
          meta: { agentType: "general-purpose", toolUseId: "toolu_y" },
        },
      ],
      classify,
    });
    const by = Object.fromEntries(run.agents.map((a) => [a.agentId, a]));
    expect(by["agent-fork1"].role).toBe("code-review fork");
    expect(by["agent-fork1"].description).toBe("/code-review (fork)");
    expect(by["agent-fork1"].parentToolUseId).toBe("s1");
    expect(by["agent-dev1"].role).toBe("general-purpose");
  });

  test("agents running at the same time cost one wall-clock minute, not two", () => {
    const run = buildRun({
      sessionId: "s1",
      slug: "-p",
      agents: [
        { agentId: "a", body, meta: { agentType: "developer" } },
        { agentId: "b", body, meta: { agentType: "developer" } },
      ],
      classify,
    });
    expect(run.activeMs).toBe(1000);
  });

  test("an empty transcript yields a run rather than throwing", () => {
    const run = buildRun({ sessionId: "s1", slug: "-p", classify });
    expect(run.turnCount).toBe(0);
    expect(run.durationMs).toBe(0);
  });
});

describe("the initial context, from the transcript's attachments", () => {
  const body = [
    attachment(0, {
      type: "prompt_snapshot",
      systemPrompt: "x".repeat(900),
      tools: "t".repeat(4000),
    }),
    // A second snapshot states the whole current value again, and a later one can be
    // SMALLER. Summing them doubled every agent's reported starting context; taking the
    // last one understated it. Sized so 4000 (largest), 5000 (sum) and 1000 (last) are
    // three different answers.
    attachment(1, {
      type: "prompt_snapshot",
      systemPrompt: "x".repeat(900),
      tools: "t".repeat(1000),
    }),
    attachment(2, {
      type: "skill_listing",
      content: "s".repeat(600),
      skillCount: 42,
    }),
    attachment(3, {
      type: "instructions",
      files: [
        { path: "/p/CLAUDE.md", content: "c".repeat(300) },
        { path: "/p/AGENTS.md", content: "a".repeat(120) },
      ],
    }),
    assistant(4, "msg-1", [{ type: "text", text: "." }]),
  ].join("\n");

  test("a snapshot is sized at its largest, never summed", () => {
    const { context } = parseTranscript(body, classify);
    expect(context.find((c) => c.component === "tools").bytes).toBe(4000);
    expect(context.find((c) => c.component === "system").bytes).toBe(900);
  });

  test("the skill listing carries how many skills it listed", () => {
    const { context } = parseTranscript(body, classify);
    expect(context.find((c) => c.component === "skills")).toMatchObject({
      bytes: 600,
      detail: "42 skills listed",
    });
  });

  test("each injected instruction file is sized on its own", () => {
    const { context } = parseTranscript(body, classify);
    expect(context.find((c) => c.component === "file:/p/CLAUDE.md").bytes).toBe(
      300,
    );
    expect(context.find((c) => c.component === "file:/p/AGENTS.md").bytes).toBe(
      120,
    );
  });

  test("an attachment is not a turn", () => {
    const { turns } = parseTranscript(body, classify);
    expect(turns).toHaveLength(1);
  });
});

describe("splitGaps", () => {
  test("separates coordination turnaround from a stall", () => {
    // One 90-minute pause and a handful of two-second ones are different phenomena, and a
    // single "dead time" number described neither.
    const { coordMs, stalls } = splitGaps([
      [0, 1000],
      [3000, 4000], //           a 2s gap: turnaround
      [4000 + STALL_MS * 2, 5000 + STALL_MS * 2], // a long one: an incident
    ]);
    expect(coordMs).toBe(2000);
    expect(stalls).toHaveLength(1);
    expect(stalls[0]).toMatchObject({ at: 4000, ms: STALL_MS * 2 });
  });

  test("overlapping spans leave no gap between them", () => {
    expect(
      splitGaps([
        [0, 5000],
        [1000, 9000],
      ]).coordMs,
    ).toBe(0);
  });

  test("stalls come back longest first, to be opened one by one", () => {
    const { stalls } = splitGaps([
      [0, 1],
      [STALL_MS + 1, STALL_MS + 2],
      [STALL_MS * 4, STALL_MS * 4 + 1],
    ]);
    expect(stalls.map((g) => g.ms)).toEqual(
      [...stalls.map((g) => g.ms)].sort((a, b) => b - a),
    );
  });
});

describe("hooks.log is the only trace of a SubagentStop", () => {
  // The transcript records PreToolUse and PostToolUse with their durations and nothing at
  // all for the hooks that fire when an agent stops, which is where the validation chain
  // runs. Without this file a five-minute silence that was a typecheck plus a test suite is
  // indistinguishable from a human walking away.
  const log = [
    "[2026-09-01T10:00:00.000Z] [validate-on-stop] START role=developer wt=/wt base=session/x",
    "[2026-09-01T10:02:30.000Z] [validate-on-stop] typecheck passed",
    "not the grammar, skipped",
    "[2026-09-01T10:04:00.000Z] [validate-on-stop] FAILED unit",
  ].join("\n");

  test("every well-formed line is kept, in order, with its moment", () => {
    const events = hookEvents(log);
    expect(events).toHaveLength(3);
    expect(events[0].hook).toBe("validate-on-stop");
    expect(events[2].at).toBeGreaterThan(events[0].at);
  });

  test("the span of a validation chain is recoverable from it", () => {
    const events = hookEvents(log);
    expect(events[events.length - 1].at - events[0].at).toBe(4 * 60 * 1000);
  });
});

describe("hook runs, from the transcript", () => {
  test("fold per hook and event, with their time and their failures", () => {
    const [row] = rollupHookRuns([
      {
        hook: "format-on-write",
        event: "PostToolUse",
        ms: 120,
        exitCode: 0,
        ok: true,
      },
      {
        hook: "format-on-write",
        event: "PostToolUse",
        ms: 80,
        exitCode: 2,
        ok: true,
      },
      {
        hook: "format-on-write",
        event: "PostToolUse",
        ms: 100,
        exitCode: 0,
        ok: false,
      },
    ]);
    expect(row).toMatchObject({
      hook: "format-on-write",
      runs: 3,
      ms: 300,
      failures: 2,
    });
  });
});

describe("a run is named, not just numbered", () => {
  const title = (ms, t) =>
    JSON.stringify({
      type: "ai-title",
      timestamp: at(ms),
      aiTitle: t,
      sessionId: "s",
    });
  const userText = (ms, text) =>
    JSON.stringify({
      type: "user",
      timestamp: at(ms),
      message: { content: [{ type: "text", text }] },
    });

  test("the last ai-title wins, because they are refined as the session goes", () => {
    // One archived session carries forty of them; only the final one names the run a
    // reader would recognise.
    const body = [
      title(0, "First guess"),
      title(1000, "What it turned out to be"),
    ].join("\n");
    expect(sessionTitle(body)).toBe("What it turned out to be");
  });

  test("with no title, the command the session opened on names it", () => {
    // Six sessions in sixty have no title at all, and every one of them started with a
    // command. "/dev-review delta 156" beats an id.
    const body = [
      userText(
        0,
        "<command-message>dev-review</command-message>\n" +
          "<command-name>/dev-review</command-name>\n" +
          "<command-args>delta 156</command-args>",
      ),
    ].join("\n");
    expect(sessionTitle(body)).toBe("/dev-review delta 156");
  });

  test("a command with no argument still names it", () => {
    const body = userText(
      0,
      "<command-name>/pr</command-name><command-args></command-args>",
    );
    expect(sessionTitle(body)).toBe("/pr");
  });

  test("injected framing is never a name", () => {
    // Taking the first user text verbatim titled eight real runs "Base directory for this
    // skill: /home/node/.claude/skills/dev-review", which is the skill talking.
    const body = [
      userText(
        0,
        "Base directory for this skill: /home/node/.claude/skills/dev-review",
      ),
      userText(1000, "Caveat: the messages below were generated by the user"),
      userText(2000, "Fix the contact filter"),
    ].join("\n");
    expect(sessionTitle(body)).toBe("Fix the contact filter");
  });

  test("a title beats a command, and a command beats a prompt", () => {
    const cmd = userText(0, "<command-name>/dev-review</command-name>");
    const typed = userText(1000, "do the thing");
    expect(
      sessionTitle([cmd, typed, title(2000, "Real title")].join("\n")),
    ).toBe("Real title");
    expect(sessionTitle([cmd, typed].join("\n"))).toBe("/dev-review");
    expect(sessionTitle(typed)).toBe("do the thing");
  });

  test("a session that said nothing has no name rather than a made-up one", () => {
    expect(sessionTitle("")).toBe(null);
    expect(
      sessionTitle(userText(0, "<command-message>x</command-message>")),
    ).toBe(null);
  });
});

describe("a session is not a run", () => {
  // The main thread's work before a harness agent starts is the developer's own. Counting it
  // as harness cost would make the main thread the most expensive role of every pipeline,
  // which is the opposite of what the pipeline does.
  const turnAt = (ms, id) =>
    assistant(ms, id, [toolUse("t" + id, "Read", { file_path: "/a.ts" })]);
  const mainBody = [
    turnAt(0, "m1"),
    result(100, "tm1"),
    turnAt(60000, "m2"),
    result(60100, "tm2"),
    turnAt(120000, "m3"),
    result(120100, "tm3"),
  ].join("\n");
  const subBody = [turnAt(60000, "s1"), result(61000, "ts1")].join("\n");

  const run = buildRun({
    sessionId: "s1",
    slug: "-p",
    mainBody,
    agents: [
      { agentId: "dev", body: subBody, meta: { agentType: "developer" } },
    ],
    classify,
  });

  test("the window is the span its subagents cover", () => {
    expect(run.windowStart).toBe(Date.parse("2026-09-01T10:01:00.000Z"));
    expect(run.windowEnd).toBe(Date.parse("2026-09-01T10:01:01.000Z"));
  });

  test("only the host turns inside the window count towards the run", () => {
    const main = run.agents.find((a) => a.agentId === "main");
    expect(main.turns).toBe(3);
    expect(main.turnsInWindow).toBe(1);
    expect(main.outsideTurns).toBe(2);
  });

  test("what the session did outside is reported, not folded in and not dropped", () => {
    expect(run.hostTurns).toBe(2);
    expect(run.hostUsd).toBeGreaterThan(0);
    expect(run.usd).toBeCloseTo(
      run.agents.reduce((s, a) => s + a.usdInWindow, 0),
      10,
    );
  });

  test("a session with no subagent is the run, whole", () => {
    const solo = buildRun({ sessionId: "s2", slug: "-p", mainBody, classify });
    expect(solo.windowStart).toBe(null);
    expect(solo.hostTurns).toBe(0);
    expect(solo.turnCount).toBe(3);
  });

  const roles = new Set(["developer", "orchestrator"]);
  const withSub = (agentType, extra = {}) =>
    buildRun({
      sessionId: "s3",
      slug: "-p",
      mainBody,
      agents: [{ agentId: "sub", body: subBody, meta: { agentType } }],
      classify,
      harnessRoles: roles,
      ...extra,
    });

  test("a harness role opens the window, namespaced or bare", () => {
    const start = Date.parse("2026-09-01T10:01:00.000Z");
    expect(withSub("developer").windowStart).toBe(start);
    expect(withSub("aiharness:orchestrator").windowStart).toBe(start);
  });

  test("a subagent outside the harness roles leaves the session whole", () => {
    const run = withSub("Explore");
    expect(run.windowStart).toBe(null);
    expect(run.hostTurns).toBe(0);
    // the main thread's three turns and the subagent's one
    expect(run.turnCount).toBe(4);
  });

  test("`whole` counts the session even around a harness agent", () => {
    const run = withSub("developer", { whole: true });
    expect(run.windowStart).toBe(null);
    expect(run.hostTurns).toBe(0);
    expect(run.turnCount).toBe(4);
  });
});
