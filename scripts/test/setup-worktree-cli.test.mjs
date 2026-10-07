// Tests for scripts/setup-worktree.mjs: the second caller of the worktree setup.
//
// A developer dispatched by a workflow gets no PreToolUse(Agent) hook, because a
// workflow's `agent()` is not an Agent tool call. This CLI is how it provisions itself,
// and the property that makes it safe to call on BOTH paths is that it adopts an
// existing worktree instead of recreating one: on the hook path it must be a no-op.
//
// Same throwaway repo and HARNESS_TMP_ROOT as the hook's own tests, so the two callers
// are measured against the same topology.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { sanitizePath } from "../../hooks/lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "setup-worktree.mjs");
const HOOK = join(HERE, "..", "..", "hooks", "setup-worktree.mjs");
const SESSION_ID = "cd34ef56-1111-2222-3333-444455556666";
const SS = SESSION_ID.split("-")[0];

let TMP;
let APP_DIR;
let WB;
let env;

const g = (...args) =>
  spawnSync("git", ["-C", APP_DIR, ...args], { encoding: "utf8" });

const cli = (...argv) =>
  spawnSync("node", [CLI, ...argv], { env, encoding: "utf8" });

/** The hook path, for the no-op case. */
const viaHook = (taskId) =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      tool_input: {
        subagent_type: "developer",
        name: `developer-${taskId}`,
        prompt:
          `ROLE: developer\nTASK_ID: ${taskId}\n` +
          `WORKTREE_PATH: ${join(WB, taskId)}\nBRANCH_NAME: ${SS}/${taskId}`,
      },
    }),
    env,
    encoding: "utf8",
  });

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "setup-wt-cli-"));
  APP_DIR = join(TMP, "app");
  mkdirSync(APP_DIR, { recursive: true });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(APP_DIR, "seed.txt"), "seed\n");
  g("add", ".");
  g("commit", "-q", "-m", "seed");
  mkdirSync(join(APP_DIR, "node_modules"), { recursive: true });

  const HARNESS_TMP_ROOT = join(TMP, "scratch");
  WB = join(HARNESS_TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);

  env = {
    ...process.env,
    APP_DIR,
    HARNESS_TMP_ROOT,
    CLAUDE_CODE_SESSION_ID: SESSION_ID,
  };
  delete env.VALIDATE_WORKTREE;
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("setup-worktree CLI", () => {
  test("creates the ticket's worktree on the topology's own names", () => {
    const r = cli("--task", "TASK-010");
    expect(r.status).toBe(0);
    expect(existsSync(join(WB, "TASK-010"))).toBe(true);
    expect(r.stdout).toContain(`WORKTREE_PATH: ${join(WB, "TASK-010")}`);
    expect(r.stdout).toContain(`BRANCH_NAME: ${SS}/TASK-010`);
  });

  test("forks from the session integration branch, not from HEAD", () => {
    // This is the difference native `isolation: 'worktree'` cannot provide, and the
    // merger depends on it: a ticket branch has to descend from session/<short>.
    const merged = spawnSync(
      "git",
      [
        "-C",
        APP_DIR,
        "branch",
        "--contains",
        `session/${SS}`,
        "--list",
        `${SS}/TASK-010`,
      ],
      { encoding: "utf8" },
    );
    expect(merged.stdout.trim()).toContain(`${SS}/TASK-010`);
  });

  test("provisions dependencies into the worktree", () => {
    // A developer must not start in a worktree with no node_modules.
    expect(existsSync(join(WB, "TASK-010", "node_modules"))).toBe(true);
  });

  test("a second run adopts the worktree instead of recreating it", () => {
    writeFileSync(join(WB, "TASK-010", "mine.txt"), "work in progress\n");
    const r = cli("--task", "TASK-010");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already registered");
    // The point of the property: a developer's work survives a second call.
    expect(existsSync(join(WB, "TASK-010", "mine.txt"))).toBe(true);
  });

  test("the hook having run first makes the CLI a no-op", () => {
    // The case on the Agent path: both callers fire, and the second must change nothing.
    expect(viaHook("TASK-011").status).toBe(0);
    const r = cli("--task", "TASK-011");
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("already registered");
    expect(r.stdout).toContain(`BRANCH_NAME: ${SS}/TASK-011`);
  });

  test("--simple derives the shared simple worktree", () => {
    const r = cli("--simple");
    expect(r.status).toBe(0);
    expect(existsSync(join(WB, "simple"))).toBe(true);
    expect(r.stdout).toContain(`BRANCH_NAME: ${SS}/simple`);
  });

  test("a malformed task id is refused before anything is created", () => {
    const r = cli("--task", "TASK_12");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("not a TASK-NNN id");
    expect(existsSync(join(WB, "TASK_12"))).toBe(false);
  });

  test("no arguments prints what it wants and creates nothing", () => {
    const r = cli();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("usage:");
  });

  test("without a session id it refuses rather than keying on a shared path", () => {
    // Every marker is keyed on the session; a fallback would mix two sessions' worktrees.
    const bare = { ...env };
    delete bare.CLAUDE_CODE_SESSION_ID;
    const r = spawnSync("node", [CLI, "--task", "TASK-012"], {
      env: bare,
      encoding: "utf8",
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("no session id");
  });
});
