// Tests for session-cost.mjs, the per-agent token tally.
//
// Driven through spawnSync, like harness-revert.test.mjs: the script parses argv and exits
// at import time, so it cannot be imported to reach its internals.
//
// What must never break: what counts as a turn (only a billed assistant message), and the
// split between turns that called a tool and turns that only produced text. That split is
// the reason the script exists, and no usage total shows it.

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

/** One billed assistant message. */
const assistant = (content, over) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      model: "claude-sonnet-5",
      content,
      usage: usage(over),
    },
  });

const text = (t = "thinking") => [{ type: "text", text: t }];
const tool = (n = 1) =>
  Array.from({ length: n }, () => ({ type: "tool_use", name: "Read", input: {} }));

/**
 * Lay out one session the way the runtime does, with one subagent per entry.
 * @param {{role: string, desc?: string, lines: string[]}[]} agents
 */
const session = (agents) => {
  TMP = mkdtempSync(join(tmpdir(), "session-cost-test-"));
  const projectDir = join(TMP, "projects", SLUG);
  const subagents = join(projectDir, SESSION, "subagents");
  mkdirSync(subagents, { recursive: true });
  writeFileSync(join(projectDir, `${SESSION}.jsonl`), "");
  agents.forEach((a, i) => {
    const id = `a${i}`;
    writeFileSync(
      join(subagents, `agent-${id}.meta.json`),
      JSON.stringify({ agentType: a.role, description: a.desc || "" }),
    );
    writeFileSync(join(subagents, `agent-${id}.jsonl`), a.lines.join("\n") + "\n");
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
      { role: "developer", lines: [assistant(text()), assistant(text()), assistant(tool())] },
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

  test("reports 1.0 when nothing was ever batched", () => {
    const dir = session([
      { role: "developer", lines: [assistant(tool()), assistant(tool()), assistant(text())] },
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
          JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
          assistant(tool()),
        ],
      },
    ]);
    expect(run(dir).stdout).toContain("1 agents, 1 turns");
  });

  test("--by-role aggregates and ranks by cache read", () => {
    const dir = session([
      { role: "merger", lines: [assistant(tool(), { cache_read_input_tokens: 1000 })] },
      { role: "developer", lines: [assistant(tool(), { cache_read_input_tokens: 900000 })] },
      { role: "developer", lines: [assistant(tool(), { cache_read_input_tokens: 900000 })] },
    ]);
    const out = run(dir, "--by-role").stdout;
    const devLine = out.split("\n").find((l) => l.startsWith("developer"));
    const mergerLine = out.split("\n").find((l) => l.startsWith("merger"));
    expect(devLine).toMatch(/developer\s+2/);
    expect(out.indexOf("developer")).toBeLessThan(out.indexOf("merger"));
    expect(mergerLine).toContain("0%");
  });

  test("strips the plugin namespace from a role name", () => {
    const dir = session([{ role: "aiharness:developer", lines: [assistant(tool())] }]);
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
    const r = spawnSync("node", [SCRIPT, SESSION, "--project", "-no-such-project"], {
      encoding: "utf8",
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no transcript at");
  });

  test("explains an empty session instead of printing an empty table", () => {
    const dir = session([]);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no subagent transcripts");
  });
});
