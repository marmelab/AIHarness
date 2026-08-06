// The reject-with-feedback path: what the harness emits when it refuses a stop.
//
// ============================================================================
// READ THIS FIRST: the reject mechanism is ADVISORY, not verified end to end.
// ============================================================================
//
// The loop rules/validation-commands.md describes has two halves: the hook refuses the
// stop with exit 2 and an explanation, then the runtime injects that explanation into the
// stopping agent's context so it can fix and stop again. Only the FIRST half is the
// harness's, and only the first half is tested here. Whether the runtime delivers a hook's
// stderr to a subagent is NOT established, and cannot be tested from this repo: it needs a
// live session dispatching a real subagent.
//
// Until the manual check below settles it, treat every refusal as advisory:
//
//   - never make correctness depend on an agent reacting to a rejection. Every refusal
//     carries a budget and an honest exit (rules/hook-authoring.md), and that is what
//     holds the line.
//   - the enforcement that does not need the agent is at the merge:
//     block-merger-without-review reads the give-up marker and refuses the ticket. Keep
//     new invariants there, not in a refusal loop.
//   - agents/developer.md states the clean-tree precondition directly, so a compliant
//     developer never reaches the rejection in the first place.
//
// MANUAL VERIFICATION (against a live runtime, then update this header):
//   1. Dispatch one developer on a SIMPLE change with `VALIDATE_DRY_RUN=fail` set.
//   2. Let it stop. The hook exits 2 with "Validation failed at step 'dry-run'".
//   3. Read <main-transcript-dir>/<session-id>/subagents/agent-<id>.jsonl for that agent
//      and grep for "Validation failed".
//   4. Present  => the loop works; narrow this header to say so and drop the advisory
//      framing. Absent => the rejection text is for the human reading hooks.log, nobody
//      else, and this header stands as written.

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
const SESSION_ID = "fb1a2b3c-1111-2222-3333-444455556666";
const SHORT = "fb1a2b3c";

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
      { id: "unit-app", kind: "unit", command: "false" },
    ],
    extraForbidden: [],
  },
  roles: { developer: { validate: true, model: "sonnet" } },
};

let TMP, APP_DIR, SESSION_DIR, WT, layout, env;

const g = (cwd, ...args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const stop = () =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify(stopPayload(layout, "a00000000000000201")),
    env,
    encoding: "utf8",
  });

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "validation-feedback-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  SESSION_DIR = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(join(APP_DIR, "harness.config.json"), JSON.stringify(CONFIG));

  g(APP_DIR, "init", "-q", "-b", "main");
  g(APP_DIR, "config", "user.email", "t@t.t");
  g(APP_DIR, "config", "user.name", "t");
  writeFileSync(join(APP_DIR, "seed.ts"), "export const a = 1;\n");
  g(APP_DIR, "add", "-A");
  g(APP_DIR, "commit", "-q", "-m", "seed");
  g(APP_DIR, "branch", `session/${SHORT}`);

  WT = join(SESSION_DIR, "TASK-001");
  g(
    APP_DIR,
    "worktree",
    "add",
    "-q",
    "-b",
    `${SHORT}/TASK-001`,
    WT,
    `session/${SHORT}`,
  );
  writeFileSync(join(WT, "work.ts"), "export const b = 2;\n");
  g(WT, "add", "-A");
  g(WT, "commit", "-q", "-m", "feat(TASK-001): work");

  layout = runtimeLayout(join(TMP, "transcripts"), SESSION_ID);
  spawnAgent(
    layout,
    "a00000000000000201",
    { agentType: "developer", description: "Implement TASK-001: work" },
    "ROLE: developer\nTASK_ID: TASK-001\n",
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

describe("what the harness emits on a refused stop", () => {
  test("exit 2, which is the runtime's signal to keep the agent alive", () => {
    expect(stop().status).toBe(2);
  });

  test("the message names the step, the worktree and the budget", () => {
    const { stderr } = stop();
    expect(stderr).toContain("unit-app");
    expect(stderr).toContain(WT);
    expect(stderr).toContain("attempt 1/5");
  });

  test("a dirty stop names the files, so the fix needs no guesswork", () => {
    writeFileSync(join(WT, "work.ts"), "export const b = 3;\n");
    const { stderr } = stop();
    expect(stderr).toContain("Commit your work before stopping");
    expect(stderr).toContain("work.ts");
  });

  // The one thing that does NOT depend on the agent reading anything: the give-up marker,
  // which block-merger-without-review reads to refuse the ticket. This is where "never
  // merge red" actually lives, precisely because the feedback loop above is unverified.
  test("the give-up marker is written whether or not the agent ever read a rejection", () => {
    for (let i = 0; i < 5; i++) stop();
    const marker = join(SESSION_DIR, "validation-gave-up", "TASK-001");
    expect(spawnSync("test", ["-f", marker]).status).toBe(0);
  });
});
