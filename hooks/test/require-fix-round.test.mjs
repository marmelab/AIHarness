// Tests for require-fix-round: a second review of the same ticket must be narrowed.
//
// The mechanical question is "is this a re-review", and the tests pin the answer the guard
// uses: its own per-ticket dispatch count. The review verdict flag cannot answer it, since
// reviews.mjs writes that flag only on APPROVED and clears it on REJECTED and on every
// developer re-dispatch, so its absence is exactly the state of a ticket about to be
// re-reviewed.
//
// The count must include a REFUSED attempt. Otherwise the retry that adds FIX_ROUND looks
// like the first review of the ticket and is waved through without it, which is the same
// hole the guard exists to close.

import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizePath } from "../lib/paths.mjs";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "require-fix-round.mjs",
);

const SESSION_ID = "fix-round-test";

// Same shape every hook test uses: APP_DIR names the repo, HARNESS_TMP_ROOT the scratch
// root, and the session dir the guard writes into is derived from the two.
let root = null;
let env = null;
let session = null;
const startSession = () => {
  root = mkdtempSync(join(tmpdir(), "fix-round-"));
  const appDir = join(root, "repo");
  const tmpRoot = join(root, "scratch");
  env = { ...process.env, APP_DIR: appDir, HARNESS_TMP_ROOT: tmpRoot };
  delete env.CLAUDE_PROJECT_DIR;
  session = join(tmpRoot, sanitizePath(appDir), SESSION_ID);
};
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  env = null;
  session = null;
});

const FIX_BLOCK = [
  "FIX_ROUND: 1",
  "FIX_RANGE: abc123..def456",
  "FINDINGS_RAISED: the select could submit an empty string",
].join("\n");

/**
 * Dispatch a reviewer for `taskId`. All calls in one test share a session dir, so the
 * guard's per-ticket counter carries across them the way it does in a real run.
 */
const dispatch = ({
  taskId = "TASK-001",
  extra = "",
  mode,
  role = "aiharness:quality-reviewer",
} = {}) => {
  if (!session) startSession();
  const lines = [
    "ROLE: quality-reviewer",
    `TASK_ID: ${taskId}`,
    `WORKTREE_PATH: /tmp/wt/${taskId}`,
    ...(mode ? [`MODE: ${mode}`] : []),
    ...(extra ? [extra] : []),
  ];
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: {
        subagent_type: role,
        description: `Review ${taskId}`,
        prompt: lines.join("\n"),
      },
    }),
    encoding: "utf8",
    env,
  });
  return { status: r.status, stderr: r.stderr, stdout: r.stdout };
};

const counter = (taskId = "TASK-001") =>
  parseInt(
    readFileSync(join(session, "review-dispatches", taskId), "utf8"),
    10,
  );

describe("require-fix-round", () => {
  test("the first review of a ticket needs no narrowing", () => {
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(counter()).toBe(1);
  });

  test("a second review without FIX_ROUND is refused", () => {
    dispatch();
    const r = dispatch();
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/RE-review/);
    expect(r.stderr).toContain("This is review 2 of TASK-001");
  });

  test("the refusal spells out the three lines to add", () => {
    dispatch();
    const r = dispatch();
    expect(r.stderr).toContain("FIX_ROUND:");
    expect(r.stderr).toContain("FIX_RANGE:");
    expect(r.stderr).toContain("FINDINGS_RAISED:");
  });

  test("a second review carrying FIX_ROUND is allowed", () => {
    dispatch();
    const r = dispatch({ extra: FIX_BLOCK });
    expect(r.status).toBe(0);
  });

  test("a refused attempt still counts, so the retry is not mistaken for a first pass", () => {
    dispatch();
    expect(dispatch().status).toBe(2);
    expect(counter()).toBe(2);
    // The orchestrator now re-issues WITH the block. That is dispatch 3, and it has to be
    // allowed: had the refusal not been counted, this one would read as review 2 and be
    // refused again, which is a loop.
    expect(dispatch({ extra: FIX_BLOCK }).status).toBe(0);
    expect(counter()).toBe(3);
  });

  test("the count is per ticket, not per session", () => {
    dispatch({ taskId: "TASK-001" });
    dispatch({ taskId: "TASK-002" });
    const r = dispatch({ taskId: "TASK-002" });
    expect(r.status).toBe(2);
    expect(counter("TASK-001")).toBe(1);
    expect(counter("TASK-002")).toBe(2);
  });

  test("a third review still needs the block", () => {
    dispatch();
    dispatch({ extra: FIX_BLOCK });
    const r = dispatch();
    expect(r.status).toBe(2);
  });

  describe("the whole-feature and migration passes are out of scope", () => {
    test.each(["feature-review", "feature-smoke", "migration-review"])(
      "MODE: %s is never refused, however often it runs",
      (mode) => {
        expect(dispatch({ mode }).status).toBe(0);
        expect(dispatch({ mode }).status).toBe(0);
        expect(dispatch({ mode }).status).toBe(0);
      },
    );
  });

  describe("fails open on ignorance", () => {
    test("a dispatch with no TASK_ID is allowed, twice over", () => {
      if (!session) startSession();
      const call = () =>
        spawnSync("node", [HOOK], {
          input: JSON.stringify({
            session_id: SESSION_ID,
            hook_event_name: "PreToolUse",
            tool_name: "Agent",
            tool_input: {
              subagent_type: "aiharness:quality-reviewer",
              prompt: "ROLE: quality-reviewer\nWORKTREE_PATH: /tmp/wt/x",
            },
          }),
          encoding: "utf8",
          env,
        });
      expect(call().status).toBe(0);
      expect(call().status).toBe(0);
    });
  });

  describe("only the reviewer is counted", () => {
    test.each(["aiharness:developer", "aiharness:merger"])(
      "%s can be dispatched repeatedly",
      (role) => {
        expect(dispatch({ role }).status).toBe(0);
        expect(dispatch({ role }).status).toBe(0);
        expect(dispatch({ role }).status).toBe(0);
      },
    );
  });
});
