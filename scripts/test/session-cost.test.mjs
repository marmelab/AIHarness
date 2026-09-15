// Tests for session-cost.mjs, the per-agent token tally.
//
// Driven through spawnSync, like harness-revert.test.mjs: the script parses argv and exits
// at import time, so it cannot be imported to reach its internals.
//
// What must never break: what counts as a turn (only a billed assistant message), and the
// split between turns that called a tool and turns that only produced text. That split is
// the reason the script exists, and no usage total shows it.
//
// These tests only see what the CLI prints; the counting rules are unit tested in
// session-cost-lib.test.mjs. A spawnSync assertion that a number was printed cannot tell a
// right number from a wrong one.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "session-cost.mjs");
const SLUG = "-fixture-project";
const SESSION = "sess-1111-2222-3333-444455556666";

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

const usage = (over = {}) => ({
  input_tokens: 0,
  output_tokens: 10,
  cache_read_input_tokens: 1000,
  cache_creation_input_tokens: 0,
  ...over,
});

const MINUTE = 60000;
const T0 = Date.parse("2026-09-07T10:00:00.000Z");
const at = (minutes) => new Date(T0 + minutes * MINUTE).toISOString();

let msgSeq = 0;

/** One billed assistant response, as a single transcript entry. */
const assistant = (content, over, id, opts = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: opts.ts || at(0),
    message: {
      id: id || `msg_${msgSeq++}`,
      role: "assistant",
      model: opts.model || "claude-sonnet-5",
      content,
      usage: usage(over),
    },
  });

/**
 * One response as the runtime actually writes it: one entry per content block, every entry
 * repeating the SAME id and the SAME usage object. Summing per entry is what inflated a
 * profiled run's turns 1.85x and its cache reads 76%.
 */
const splitResponse = (blocks, over) => {
  const id = `msg_${msgSeq++}`;
  return blocks.map((b) => assistant([b], over, id));
};

const text = (t = "thinking") => [{ type: "text", text: t }];
const tool = (n = 1) =>
  Array.from({ length: n }, () => ({
    type: "tool_use",
    name: "Read",
    input: {},
  }));

/**
 * Lay out one session the way the runtime does, with one subagent per entry.
 * @param {{role: string, desc?: string, lines: string[]}[]} agents
 */
const session = (agents, mainLines = []) => {
  TMP = mkdtempSync(join(tmpdir(), "session-cost-test-"));
  const projectDir = join(TMP, "projects", SLUG);
  const subagents = join(projectDir, SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION}.jsonl`), mainLines.join("\n"));
  agents.forEach((a, i) => {
    const id = `a${i}`;
    writeFileSync(
      join(subagents, `agent-${id}.meta.json`),
      JSON.stringify({ agentType: a.role, description: a.desc || "" }),
    );
    writeFileSync(
      join(subagents, `agent-${id}.jsonl`),
      a.lines.join("\n") + "\n",
    );
  });
  return TMP;
};

const run = (configDir, ...args) =>
  spawnSync("node", [SCRIPT, SESSION, "--project", SLUG, ...args], {
    encoding: "utf8",
    env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
  });

describe("session-cost", () => {
  test("reports turns, cache reads and the no-tool share", () => {
    const dir = session([
      {
        role: "developer",
        lines: [assistant(text()), assistant(text()), assistant(tool())],
      },
    ]);
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 agents, 3 turns");
    expect(r.stdout).toContain("0.00M cache-read");
    // 2 of 3 turns produced no tool call.
    expect(r.stdout).toContain("2/3 (67%)");
  });

  test("counts every tool_use in one message, so batching shows up", () => {
    const dir = session([{ role: "developer", lines: [assistant(tool(4))] }]);
    expect(run(dir).stdout).toContain("tool calls per tool-using turn: 4.0");
  });

  test("counts a response split across entries as ONE turn", () => {
    // The regression that made this script wrong on its first run: a response that thinks
    // and then calls two tools is three transcript entries carrying one identical usage
    // object. Per entry that reads as 3 turns and 3000 cache-read tokens, one of them
    // apparently producing nothing.
    const dir = session([
      {
        role: "developer",
        lines: splitResponse([
          { type: "thinking", thinking: "which file" },
          { type: "tool_use", name: "Read", input: {} },
          { type: "tool_use", name: "Read", input: {} },
        ]),
      },
    ]);
    const out = run(dir).stdout;
    expect(out).toContain("1 agents, 1 turns");
    expect(out).toContain("0.00M cache-read");
    expect(out).toContain("tool calls per tool-using turn: 2.0");
    expect(out).toContain("0/1 (0%)");
  });

  test("a thinking-only response with no tool call still counts once", () => {
    const dir = session([
      {
        role: "developer",
        lines: splitResponse([{ type: "thinking", thinking: "hm" }]),
      },
    ]);
    const out = run(dir).stdout;
    expect(out).toContain("1 agents, 1 turns");
    expect(out).toContain("1/1 (100%)");
  });

  test("reports 1.0 when no response ever called two tools at once", () => {
    const dir = session([
      {
        role: "developer",
        lines: [assistant(tool()), assistant(tool()), assistant(text())],
      },
    ]);
    expect(run(dir).stdout).toContain("tool calls per tool-using turn: 1.0");
  });

  test("ignores assistant messages the runtime never billed", () => {
    // Mid-turn snapshots carry no usage block. Counting them would inflate every turn
    // count and deflate every per-turn average.
    const dir = session([
      {
        role: "developer",
        lines: [
          JSON.stringify({ type: "assistant", message: { content: [] } }),
          JSON.stringify({
            type: "user",
            message: { role: "user", content: "go" },
          }),
          assistant(tool()),
        ],
      },
    ]);
    expect(run(dir).stdout).toContain("1 agents, 1 turns");
  });

  test("--by-role aggregates and ranks by cache read", () => {
    const dir = session([
      {
        role: "merger",
        lines: [assistant(tool(), { cache_read_input_tokens: 1000 })],
      },
      {
        role: "developer",
        lines: [assistant(tool(), { cache_read_input_tokens: 900000 })],
      },
      {
        role: "developer",
        lines: [assistant(tool(), { cache_read_input_tokens: 900000 })],
      },
    ]);
    const out = run(dir, "--by-role").stdout;
    const devLine = out.split("\n").find((l) => l.startsWith("developer"));
    const mergerLine = out.split("\n").find((l) => l.startsWith("merger"));
    expect(devLine).toMatch(/developer\s+2/);
    expect(out.indexOf("developer")).toBeLessThan(out.indexOf("merger"));
    expect(mergerLine).toContain("0%");
  });

  test("strips the plugin namespace from a role name", () => {
    const dir = session([
      { role: "aiharness:developer", lines: [assistant(tool())] },
    ]);
    expect(run(dir, "--by-role").stdout).toMatch(/^developer\s/m);
  });

  test("survives a malformed transcript line", () => {
    const dir = session([
      { role: "developer", lines: ["{not json", assistant(tool())] },
    ]);
    expect(run(dir).stdout).toContain("1 agents, 1 turns");
  });

  test("refuses to run without a session id", () => {
    const r = spawnSync("node", [SCRIPT], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("usage:");
  });

  test("names the transcript it could not find", () => {
    const r = spawnSync(
      "node",
      [SCRIPT, SESSION, "--project", "-no-such-project"],
      {
        encoding: "utf8",
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no main transcript at");
  });

  // Transcripts are pruned after cleanupPeriodDays (30 by default) and the main thread is
  // ONE file while the subagent directory can outlive it. Refusing the run then made an
  // older benchmark impossible to re-cost, which is the case the tool is kept for.
  test("a pruned main transcript costs the agents anyway, and says what is missing", () => {
    const dir = session([{ role: "developer", lines: [assistant(tool())] }]);
    rmSync(join(dir, "projects", SLUG, `${SESSION}.jsonl`), { force: true });
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 agents, 1 turns");
    expect(r.stderr).toContain("no main transcript at");
    expect(r.stderr).toContain("subagents only");
    // No main thread means no main-thread line, not a zeroed one presented as a total.
    expect(r.stdout).not.toContain("main thread");
  });

  test("explains an empty session instead of printing an empty table", () => {
    const dir = session([]);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no subagent transcripts");
  });

  test("prices the run and splits the bill by token kind", () => {
    // 1M cache read on sonnet-5 is $0.20 (0.1x the $2 rate); 100K output is $1.00.
    const dir = session([
      {
        role: "developer",
        lines: [
          assistant(tool(), {
            cache_read_input_tokens: 1e6,
            output_tokens: 1e5,
            cache_creation_input_tokens: 0,
          }),
        ],
      },
    ]);
    const out = run(dir).stdout;
    expect(out).toContain("subagents $1.20");
    expect(out).toContain("cache-read $0.20");
    expect(out).toContain("output $1.00");
  });

  test("reports the main thread separately from the agents it dispatched", () => {
    const dir = session(
      [
        {
          role: "developer",
          lines: [assistant(tool(), { cache_read_input_tokens: 1e6 })],
        },
      ],
      [assistant(tool(), { cache_read_input_tokens: 5e5 })],
    );
    const out = run(dir).stdout;
    expect(out).toContain("1 agents, 1 turns");
    expect(out).toMatch(/main thread \$0\.10 \(1 turns, not counted above\)/);
    expect(out).toContain("session total $0.30");
  });

  test("says nothing about a main thread that spent nothing", () => {
    const dir = session([{ role: "developer", lines: [assistant(tool())] }]);
    expect(run(dir).stdout).not.toContain("main thread");
  });

  test("reports fresh input, which is not cache read and not output", () => {
    const dir = session([
      {
        role: "developer",
        lines: [assistant(tool(), { input_tokens: 40000 })],
      },
    ]);
    expect(run(dir).stdout).toContain("40K fresh input");
  });

  test("counts a cache re-write after a long gap as an expiry", () => {
    const dir = session([
      {
        role: "orchestrator",
        lines: [
          assistant(tool(), { cache_read_input_tokens: 50000 }, null, {
            ts: at(0),
          }),
          assistant(
            tool(),
            {
              cache_read_input_tokens: 2000,
              cache_creation_input_tokens: 48000,
            },
            null,
            { ts: at(9) },
          ),
        ],
      },
    ]);
    const out = run(dir).stdout;
    expect(out).toContain("cache expiries: 1 turns re-wrote 48K tokens");
  });

  test("reports no expiry when the agent never idled past the TTL", () => {
    const dir = session([
      {
        role: "developer",
        lines: [
          assistant(tool(), { cache_read_input_tokens: 50000 }, null, {
            ts: at(0),
          }),
          assistant(
            tool(),
            {
              cache_read_input_tokens: 2000,
              cache_creation_input_tokens: 48000,
            },
            null,
            { ts: at(1) },
          ),
        ],
      },
    ]);
    expect(run(dir).stdout).toContain("cache expiries: 0 turns");
  });

  test("groups reviewer dispatches by kind, so a retry is not hidden in the total", () => {
    const dir = session([
      {
        role: "quality-reviewer",
        desc: "Review TASK-001",
        lines: [assistant(tool())],
      },
      {
        role: "quality-reviewer",
        desc: "Review TASK-002",
        lines: [assistant(tool())],
      },
      {
        role: "quality-reviewer",
        desc: "Re-review TASK-001 fix",
        lines: [assistant(tool())],
      },
      {
        role: "quality-reviewer",
        desc: "Review TASK-003 (verdict-flag retry)",
        lines: [assistant(tool())],
      },
      {
        role: "developer",
        desc: "Implement TASK-001",
        lines: [assistant(tool())],
      },
    ]);
    const out = run(dir).stdout;
    expect(out).toContain("review dispatches by kind:");
    expect(out).toMatch(/ticket review\s+2 dispatches/);
    expect(out).toMatch(/ticket re-review\s+1 dispatches/);
    expect(out).toMatch(/verdict-flag retry\s+1 dispatches/);
    // A developer is not a review dispatch.
    expect(out).not.toMatch(/other\s+1 dispatches/);
  });

  test("omits the review table when no reviewer ran", () => {
    const dir = session([{ role: "developer", lines: [assistant(tool())] }]);
    expect(run(dir).stdout).not.toContain("review dispatches by kind");
  });

  test("warns when a model has no rate rather than quoting a silent floor", () => {
    const dir = session([
      {
        role: "developer",
        lines: [assistant(tool(), {}, null, { model: "claude-unknown-9" })],
      },
    ]);
    const out = run(dir).stdout;
    expect(out).toContain("WARNING no rate for unknown-9");
    expect(out).toContain("the totals are a floor");
  });

  test("stays quiet about rates when every model is priced", () => {
    const dir = session([
      {
        role: "merger",
        lines: [
          assistant(tool(), {}, null, { model: "claude-haiku-4-5-20251001" }),
        ],
      },
      {
        role: "developer",
        lines: [assistant(tool(), {}, null, { model: "claude-opus-5" })],
      },
    ]);
    expect(run(dir).stdout).not.toContain("WARNING no rate");
  });

  test("--by-role ranks by dollars and names the models each role used", () => {
    const dir = session([
      {
        role: "merger",
        lines: [
          assistant(tool(), { cache_read_input_tokens: 1000 }, null, {
            model: "claude-haiku-4-5-20251001",
          }),
        ],
      },
      {
        role: "quality-reviewer",
        desc: "Review TASK-001",
        lines: [
          assistant(tool(), { cache_read_input_tokens: 2e6 }, null, {
            model: "claude-opus-5",
          }),
        ],
      },
    ]);
    const out = run(dir, "--by-role").stdout;
    expect(out.indexOf("quality-reviewer")).toBeLessThan(out.indexOf("merger"));
    expect(out).toMatch(/quality-reviewer\s+1.*opus-5/);
    expect(out).toMatch(/merger\s+1.*haiku-4-5/);
  });

  test("--json emits the totals a second counter can be checked against", () => {
    const dir = session([
      {
        role: "developer",
        lines: [assistant(tool(), { cache_read_input_tokens: 1e6 })],
      },
    ]);
    const r = run(dir, "--json");
    expect(r.status).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.session).toBe(SESSION);
    expect(parsed.totals.turns).toBe(1);
    expect(parsed.totals.cacheRead).toBe(1e6);
    expect(parsed.totals.usd).toBeCloseTo(0.2001, 4);
    expect(parsed.agents).toHaveLength(1);
  });
});
