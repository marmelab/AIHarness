// Tests for reading a session through its OWN project's harness config.
//
// A report over every project runs from one directory and reads sessions from all of them,
// so the config cannot be the one beside the script: it is the one in the directory the
// session ran in, and a harness agent dispatched through the plugin is recognised even
// where that config is gone.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  harnessConfigFor,
  harnessRoles,
  sessionCwd,
} from "../lib/harness-context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const INGEST = join(HERE, "..", "run-ingest.mjs");

let root = null;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

const at = (minute) =>
  `2026-09-01T10:${String(minute).padStart(2, "0")}:00.000Z`;
const prompt = (minute, cwd) =>
  JSON.stringify({
    type: "user",
    timestamp: at(minute),
    cwd,
    message: { role: "user", content: "go" },
  });
const turn = (minute, id) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(minute),
    message: {
      id,
      model: "claude-sonnet-5",
      usage: { input_tokens: 10, output_tokens: 40 },
      content: [{ type: "text", text: "done" }],
    },
  });

/**
 * One live session: a main thread from minute 0 to 30, and one subagent of the given type
 * from minute 10 to 20, run in `cwd`, optionally with a harness.config.json there.
 */
function liveSession({ agentType, config = null, hooksLog = null }) {
  root = mkdtempSync(join(tmpdir(), "harness-context-"));
  const cwd = join(root, "project");
  mkdirSync(cwd, { recursive: true });
  if (config)
    writeFileSync(join(cwd, "harness.config.json"), JSON.stringify(config));

  const slug = "-project";
  const id = "aaaaaaaa-0000-0000-0000-000000000000";
  const projectDir = join(root, "config", "projects", slug);
  const subs = join(projectDir, id, "subagents");
  mkdirSync(subs, { recursive: true });
  writeFileSync(
    join(projectDir, `${id}.jsonl`),
    [prompt(0, cwd), turn(1, "m1"), turn(30, "m2")].join("\n"),
  );
  writeFileSync(
    join(subs, "agent-x.jsonl"),
    [turn(10, "s1"), turn(20, "s2")].join("\n"),
  );
  writeFileSync(join(subs, "agent-x.meta.json"), JSON.stringify({ agentType }));
  if (hooksLog) writeFileSync(join(projectDir, id, "hooks.log"), hooksLog);

  const db = join(root, "runs.sqlite");
  const r = spawnSync(
    process.execPath,
    [INGEST, "--live", "--session", id, "--slug", slug, "--db", db],
    {
      encoding: "utf8",
      // Run from a directory with no config of its own, so only the session's can apply.
      cwd: root,
      env: { ...process.env, CLAUDE_CONFIG_DIR: join(root, "config") },
    },
  );
  expect(r.status, r.stderr).toBe(0);
  const store = new DatabaseSync(db);
  const row = store
    .prepare("SELECT window_start, has_hooks_log FROM runs")
    .get();
  store.close();
  return row;
}

describe("the run window, through the session's own context", () => {
  test("a harness agent dispatched through the plugin opens it, config or not", () => {
    const row = liveSession({ agentType: "aiharness:developer" });
    expect(row.window_start).toBe(Date.parse(at(10)));
  });

  test("another plugin's agent does not, whatever its bare name", () => {
    const row = liveSession({ agentType: "superpowers:developer" });
    expect(row.window_start).toBe(null);
  });

  test("a bare role opens it when the session's own config declares it", () => {
    const row = liveSession({
      agentType: "developer",
      config: { roles: { developer: {} } },
    });
    expect(row.window_start).toBe(Date.parse(at(10)));
  });

  test("a bare role with no config in the session's directory does not", () => {
    expect(liveSession({ agentType: "developer" }).window_start).toBe(null);
  });
});

describe("a live session's hooks.log", () => {
  test("is read from where the harness mirrors it, beside the transcripts", () => {
    const row = liveSession({
      agentType: "aiharness:developer",
      hooksLog: "[2026-09-01T10:15:00.000Z] [bash-guard] BLOCKED npm run e2e\n",
    });
    expect(row.has_hooks_log).toBe(1);
  });
});

describe("sessionCwd", () => {
  test("is the first cwd the transcript records", () => {
    const body = [
      JSON.stringify({ type: "summary" }),
      "not json",
      JSON.stringify({ type: "user", cwd: "/work/a" }),
      JSON.stringify({ type: "user", cwd: "/work/b" }),
    ].join("\n");
    expect(sessionCwd(body)).toBe("/work/a");
  });

  test("is null when no line carries one", () => {
    expect(sessionCwd(JSON.stringify({ type: "user" }))).toBe(null);
    expect(sessionCwd("")).toBe(null);
  });
});

describe("harnessConfigFor", () => {
  test("prefers the config named explicitly over the session's own", () => {
    root = mkdtempSync(join(tmpdir(), "harness-context-"));
    writeFileSync(join(root, "harness.config.json"), '{"name":"own"}');
    const named = join(root, "named.json");
    writeFileSync(named, '{"name":"named"}');
    expect(harnessConfigFor({ cwd: root }).name).toBe("own");
    expect(harnessConfigFor({ explicit: named, cwd: root }).name).toBe("named");
  });

  test("is null for a missing directory or a config that does not parse", () => {
    root = mkdtempSync(join(tmpdir(), "harness-context-"));
    expect(harnessConfigFor({ cwd: join(root, "gone") })).toBe(null);
    writeFileSync(join(root, "harness.config.json"), "{ not json");
    expect(harnessConfigFor({ cwd: root })).toBe(null);
    expect(harnessConfigFor({})).toBe(null);
  });
});

describe("harnessRoles", () => {
  test("joins the config's roles with the plugin's namespaced agents", () => {
    const roles = harnessRoles({ roles: { planner: {} } }, [
      { meta: { agentType: "aiharness:quality-reviewer" } },
      { meta: { agentType: "Explore" } },
      { meta: { agentType: "feature-dev:code-reviewer" } },
      { meta: {} },
    ]);
    expect([...roles].sort()).toEqual(["planner", "quality-reviewer"]);
  });
});
