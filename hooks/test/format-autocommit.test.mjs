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
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "validate-on-stop.mjs");
const SESSION_ID = "fmt1a2b3-1111-2222-3333-444455556666";
const SHORT = "fmt1a2b3";

let TMP, APP_DIR, WT, env, layout;

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
  g(
    APP_DIR,
    "worktree",
    "add",
    "-q",
    "-b",
    `${SHORT}/simple`,
    WT,
    `session/${SHORT}`,
  );

  // A single-shot developer on <short>/simple, in the shape the runtime sends: empty
  // agent_type, the MAIN session transcript, identity carried by agent_id, and the
  // worktree attributed from the BRANCH_NAME line of its own dispatch prompt. The
  // namespaced agentType is deliberate: that is the form the runtime writes for a
  // plugin-provided agent.
  layout = runtimeLayout(join(TMP, "transcripts"), SESSION_ID);
  spawnAgent(
    layout,
    "a00000000000000061",
    {
      agentType: "aiharness:developer",
      description: "Rename the seed constant",
    },
    `ROLE: developer\nCHANGE_REQUEST: rename it\nBRANCH_NAME: ${SHORT}/simple\n`,
  );

  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.VALIDATE_DRY_RUN;
  delete env.VALIDATE_WORKTREE;
  delete env.VALIDATE_NO_CACHE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
});

afterEach(() => {
  g(APP_DIR, "worktree", "remove", "--force", WT);
  rmSync(TMP, { recursive: true, force: true });
});

const stop = () =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify(stopPayload(layout, "a00000000000000061")),
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
    // Labelled for what it is: prettier has not run yet, so calling it a prettier
    // failure sent the agent looking in the wrong place.
    expect(r.stderr).toContain("uncommitted");
    expect(r.stderr).not.toContain("prettier failed");
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
    // The message names WHOSE work it is. 9 such commits were made in the audited run and
    // one of them broke another developer's rebase, so "which agent left this" is the
    // first thing anyone reading that history needs.
    expect(log()[0]).toContain("commit work the simple agent left uncommitted");
    expect(g(WT, "status", "--porcelain").stdout.trim()).toBe("");
  });

  // The audited run swept binary vitest failure screenshots into a ticket branch this way,
  // and that commit later broke the TASK-002 developer's rebase (about 10 minutes lost
  // cleaning history). Source is committed; a test run's image artifacts are left on disk.
  test("the fallback commit leaves untracked binary artifacts behind", () => {
    writeFileSync(join(WT, "seed.ts"), 'export const a = "renamed";\n');
    mkdirSync(join(WT, "test-results"), { recursive: true });
    writeFileSync(
      join(WT, "test-results", "failure.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x00, 0x03]),
    );
    stop();
    stop();
    expect(stop().status).toBe(0);

    const committed = g(WT, "show", "--name-only", "--format=", "HEAD")
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    expect(committed).toContain("seed.ts");
    expect(committed).not.toContain("test-results/failure.png");
    // Still on disk, and still untracked: nothing was deleted, it just was not committed.
    expect(
      g(WT, "ls-files", "--others", "--exclude-standard").stdout,
    ).toContain("test-results/failure.png");
  });

  // The formatter only ever rewrites TRACKED files, so its commit stages exactly those.
  // `git add -A` here would re-sweep whatever the fallback deliberately left out, under a
  // `style(...)` subject this time.
  test("the formatter's own commit never picks up untracked files", () => {
    // A formatter that rewrites a tracked file, so its commit path is actually reached.
    writeFileSync(
      join(APP_DIR, "harness.config.json"),
      JSON.stringify({
        ...CONFIG,
        validation: {
          steps: [
            {
              id: "prettier",
              kind: "format",
              command: "printf 'export const a = 3;\\n' > seed.ts",
              autoCommit: true,
              extensions: [".ts"],
            },
          ],
          extraForbidden: [],
        },
      }),
    );
    writeFileSync(join(WT, "untracked.ts"), "export const c = 3;\n");
    g(WT, "add", "seed.ts");
    g(WT, "commit", "-q", "-m", "simple: work");
    // Budget spent on the untracked file, so the fallback commits it and the formatter
    // runs after. Whatever the formatter commits must be tracked-only.
    stop();
    stop();
    stop();
    const style = g(WT, "log", "--format=%s")
      .stdout.split("\n")
      .find((s) => s.startsWith("style("));
    expect(style).toBeTruthy();
    const files = g(WT, "show", "--name-only", "--format=", "-1", "HEAD")
      .stdout.trim()
      .split("\n")
      .filter(Boolean);
    expect(files).toEqual(["seed.ts"]);
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
