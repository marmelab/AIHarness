// Tests for the format step's auto-commit, in lib/validation.mjs.
//
// The step exists to commit FORMATTING. It used to `git add -A`, so an agent that stopped
// without committing had its real work swept into a commit reading "auto-apply prettier".
// That happened on a live run: a one-line rename landed under a style message with no
// developer commit at all, leaving the history lying to review and to /harness-diff.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "validate-on-stop.mjs");
const SESSION_ID = "fmt1a2b3-1111-2222-3333-444455556666";
const SHORT = "fmt1a2b3";

let TMP, APP_DIR, WT, env;

const g = (cwd, ...args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

// A repo whose only validation step is the auto-committing formatter, so the test is about
// that step and nothing else. `true` always succeeds and changes nothing, which isolates
// "was the tree dirty before?" from "did the formatter rewrite anything?".
const CONFIG = {
  validation: {
    steps: [
      {
        id: "prettier",
        kind: "format",
        command: "true",
        autoCommit: true,
        extensions: [".ts"],
      },
    ],
    extraForbidden: [],
  },
  roles: { developer: { model: "sonnet" } },
};

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "fmt-autocommit-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(join(APP_DIR, "harness.config.json"), JSON.stringify(CONFIG));

  g(APP_DIR, "init", "-q", "-b", "main");
  g(APP_DIR, "config", "user.email", "t@t.t");
  g(APP_DIR, "config", "user.name", "t");
  writeFileSync(join(APP_DIR, "seed.ts"), "export const a = 1;\n");
  g(APP_DIR, "add", "-A");
  g(APP_DIR, "commit", "-q", "-m", "seed");
  g(APP_DIR, "branch", `session/${SHORT}`);

  WT = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID, "simple");
  g(APP_DIR, "worktree", "add", "-q", "-b", `${SHORT}/simple`, WT, `session/${SHORT}`);

  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.VALIDATE_DRY_RUN;
  delete env.VALIDATE_WORKTREE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CHAT_SESSION_DIR;
});

afterEach(() => {
  g(APP_DIR, "worktree", "remove", "--force", WT);
  rmSync(TMP, { recursive: true, force: true });
});

const stop = () =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      hook_event_name: "SubagentStop",
      transcript_path: "/nonexistent.jsonl",
    }),
    env,
    encoding: "utf8",
  });

const log = () => g(WT, "log", "--oneline").stdout.trim().split("\n");

describe("the format step's auto-commit", () => {
  test("rejects the stop when the agent left its work uncommitted", () => {
    writeFileSync(join(WT, "seed.ts"), 'export const a = "renamed";\n');
    const r = stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("Commit your work before stopping");
    // And crucially: it did NOT commit on the agent's behalf.
    expect(log()[0]).toContain("seed");
    expect(g(WT, "status", "--porcelain").stdout.trim()).not.toBe("");
  });

  // The enforcement is bounded on purpose. A commit can fail for reasons outside the
  // agent's control (a failing pre-commit hook), and an unbounded "commit or I refuse"
  // would wedge the pipeline, the same shape as the foreground gate that had to be relaxed.
  test("after the budget, commits the work honestly rather than wedging", () => {
    writeFileSync(join(WT, "seed.ts"), 'export const a = "renamed";\n');
    expect(stop().status).toBe(2);
    expect(stop().status).toBe(2);
    const r = stop();
    expect(r.status).toBe(0);
    expect(log()[0]).toContain("commit work the agent left uncommitted");
    expect(g(WT, "status", "--porcelain").stdout.trim()).toBe("");
  });

  test("the fallback commit never claims to be formatting", () => {
    writeFileSync(join(WT, "seed.ts"), 'export const a = "renamed";\n');
    stop();
    stop();
    stop();
    expect(log()[0]).not.toContain("auto-apply prettier");
    expect(log()[0]).not.toContain("style(");
  });

  test("committing during the budget clears it, so the next stop is clean", () => {
    writeFileSync(join(WT, "seed.ts"), 'export const a = "renamed";\n');
    expect(stop().status).toBe(2);
    g(WT, "add", "-A");
    g(WT, "commit", "-q", "-m", "simple: rename");
    expect(stop().status).toBe(0);
    // The budget reset, so a LATER lapse gets the full allowance again rather than
    // falling straight through to the fallback.
    writeFileSync(join(WT, "seed.ts"), 'export const a = "again";\n');
    expect(stop().status).toBe(2);
  });

  test("names the files it is refusing to swallow", () => {
    writeFileSync(join(WT, "seed.ts"), 'export const a = "renamed";\n');
    expect(stop().stderr).toContain("seed.ts");
  });

  test("accepts a clean tree, and commits nothing", () => {
    writeFileSync(join(WT, "seed.ts"), 'export const a = "renamed";\n');
    g(WT, "add", "-A");
    g(WT, "commit", "-q", "-m", "simple: rename");
    const before = log().length;
    const r = stop();
    expect(r.status).toBe(0);
    expect(log().length).toBe(before);
    expect(log()[0]).toContain("simple: rename");
  });

  test("an untracked file also counts as uncommitted work", () => {
    writeFileSync(join(WT, "extra.ts"), "export const b = 2;\n");
    const r = stop();
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("extra.ts");
  });
});
