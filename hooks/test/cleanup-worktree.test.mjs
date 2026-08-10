// Tests for cleanup-worktree.mjs removal semantics (vitest, Node project). A
// task worktree is removed only once its branch was merged with --no-ff into
// the session branch and the worktree is clean; fresh, unmerged, and dirty
// worktrees are preserved. Tests are ordered and stateful — each observes the
// state produced by the previous step.

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SETUP = join(HERE, "..", "setup-worktree.mjs");
const CLEANUP = join(HERE, "..", "cleanup-worktree.mjs");
const SESSION_ID = "cd34ef56-1111-2222-3333-444455556666";
const SS = SESSION_ID.split("-")[0];

let TMP;
let APP_DIR;
let WB;
let env;

const g = (...args) =>
  spawnSync("git", ["-C", APP_DIR, ...args], { encoding: "utf8" });
const gWt = (wt, ...args) =>
  spawnSync("git", ["-C", wt, ...args], { encoding: "utf8" });
const dispatch = (hook, agentType) =>
  spawnSync("node", [hook], {
    input: JSON.stringify({ agent_type: agentType, session_id: SESSION_ID }),
    env,
    encoding: "utf8",
  });
// setup-worktree is now a PreToolUse(Agent) hook — build a dispatch payload to
// provision the task worktrees this test then exercises cleanup against.
const setupDispatch = (taskId) =>
  spawnSync("node", [SETUP], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      tool_input: {
        subagent_type: "developer",
        name: `developer-${taskId}`,
        prompt: `ROLE: developer\nTASK_ID: ${taskId}\nWORKTREE_PATH: ${join(WB, taskId)}\nBRANCH_NAME: ${SS}/${taskId}`,
      },
    }),
    env,
    encoding: "utf8",
  });

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "cleanup-wt-test-"));
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

  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT };
  delete env.VALIDATE_WORKTREE;

  setupDispatch("TASK-001");
  setupDispatch("TASK-002");
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("cleanup-worktree removal semantics", () => {
  test("fresh worktrees (no commits) are preserved", () => {
    expect(dispatch(CLEANUP, "developer-TASK-001").status).toBe(0);
    expect(existsSync(join(WB, "TASK-001"))).toBe(true);
    expect(existsSync(join(WB, "TASK-002"))).toBe(true);
  });

  test("unmerged commits are preserved", () => {
    const wt = join(WB, "TASK-001");
    writeFileSync(join(wt, "work.txt"), "work\n");
    gWt(wt, "add", ".");
    gWt(wt, "commit", "-q", "-m", "TASK-001 work");
    dispatch(CLEANUP, "developer-TASK-001");
    expect(existsSync(wt)).toBe(true);
    expect(g("branch", "--list", `${SS}/TASK-001`).stdout.trim()).not.toBe("");
  });

  test("merged but dirty worktree is preserved", () => {
    const sessionWt = join(WB, "_session");
    const merge = gWt(
      sessionWt,
      "merge",
      "--no-ff",
      `${SS}/TASK-001`,
      "-m",
      "merge TASK-001",
    );
    expect(merge.status).toBe(0);
    writeFileSync(join(WB, "TASK-001", "uncommitted.txt"), "wip\n");
    dispatch(CLEANUP, "developer-TASK-001");
    expect(existsSync(join(WB, "TASK-001"))).toBe(true);
  });

  // The sweep is the MERGER's post-merge step: cleanup-worktree exits early on any stop
  // it can identify as another role. This case used to dispatch a developer and pass only
  // because identity was unresolvable on the synthetic payload, so it exercised the
  // fall-through rather than the rule. The payload now carries agent_type, as the runtime
  // really sends it, and a developer stop correctly sweeps nothing.
  test("merged clean worktree is removed, branch deleted, fresh sibling kept", () => {
    unlinkSync(join(WB, "TASK-001", "uncommitted.txt"));
    expect(dispatch(CLEANUP, "developer-TASK-001").status).toBe(0);
    expect(existsSync(join(WB, "TASK-001"))).toBe(true); // not the merger: untouched

    expect(dispatch(CLEANUP, "merger").status).toBe(0);
    expect(existsSync(join(WB, "TASK-001"))).toBe(false);
    expect(g("branch", "--list", `${SS}/TASK-001`).stdout.trim()).toBe("");
    expect(existsSync(join(WB, "TASK-002"))).toBe(true);
    expect(
      g("show-ref", "--verify", "--quiet", `refs/heads/session/${SS}`).status,
    ).toBe(0);
  });
});

// The sweep is the MERGER's post-merge step, so the role test has to go through bareRole.
// A plugin-provided agent arrives NAMESPACED, and a literal `agentType !== "merger"` never
// matches `aiharness:merger`: the skip would then fire on the merger's own stop as readily
// as on a developer's, and only the sweep's idempotence would hide it.
describe("cleanup-worktree skips by role, through bareRole", () => {
  let seq = 0;
  // A fresh session id per case, so each run writes its own hooks.log.
  const stop = (agentType) => {
    const sessionId = `ab${seq++}0ef56-1111-2222-3333-444455556666`;
    const layout = runtimeLayout(join(TMP, `rt${seq}`), sessionId);
    // The sweep needs a worktree base to sweep; without one the hook has nothing to
    // do and says nothing, which would make the merger case pass for the wrong reason.
    // The base carries the harness's OWN state dirs, which is the normal shape: they
    // are not worktrees and never will be, and each one used to earn a log line per
    // stop saying so.
    const base = join(join(TMP, "scratch"), sanitizePath(APP_DIR), sessionId);
    for (const d of ["breaker", "reviews", "locks", "tickets"]) {
      mkdirSync(join(base, d), { recursive: true });
    }
    spawnAgent(
      layout,
      "a00000000000000041",
      { agentType, description: "Merge TASK-001" },
      "ROLE: merger\nTASK_ID: TASK-001\n",
    );
    spawnSync("node", [CLEANUP], {
      input: JSON.stringify(stopPayload(layout, "a00000000000000041")),
      env,
      encoding: "utf8",
    });
    const log = join(
      join(TMP, "scratch"),
      sanitizePath(APP_DIR),
      sessionId,
      "hooks.log",
    );
    return existsSync(log) ? readFileSync(log, "utf8") : "";
  };

  test.each(["merger", "aiharness:merger"])("%s proceeds to the sweep", (t) => {
    expect(stop(t)).toContain("[cleanup-worktree] ACCEPT removed=");
  });

  // The volume criterion, not a style preference: this hook wrote 1521 lines in one
  // session and 1299 of them were skips. A sweep that removes nothing is the common
  // case, and it must cost one line, with the reasons folded into it.
  test("a sweep that removes nothing writes exactly one line", () => {
    const log = stop("merger");
    const lines = log
      .split("\n")
      .filter((l) => l.includes("[cleanup-worktree]"));
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("removed=0");
  });

  // Every stop of every role reaches this hook, so the roles it has nothing to do for
  // must leave NOTHING behind: one line each would be one line per subagent stop for
  // the whole session, all of them saying the hook was not asked for anything.
  test.each(["developer", "aiharness:developer"])(
    "%s writes no line at all",
    (t) => {
      expect(stop(t)).not.toContain("[cleanup-worktree]");
    },
  );
});
