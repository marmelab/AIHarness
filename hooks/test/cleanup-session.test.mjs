// Tests for cleanup-session.mjs: the SessionEnd hook that tears down this
// session's worktrees (_session, simple, TASK-XXX) under <WORKTREE_BASE> and
// removes the promotion lock + Playwright test-results. Builds a throwaway repo
// with real worktrees ("claude" Node project, real git/worktree work).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "cleanup-session.mjs");
const SESSION_ID = "cafe1234-1111-2222-3333-444455556666";
const SHORT = SESSION_ID.split("-")[0];
const sanitize = (p) => p.replace(/\//g, "_");

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

// A throwaway repo with a session branch + a _session and a simple worktree, plus
// the leftover files. Returns paths and a run() that fires the SessionEnd hook.
const setup = () => {
  TMP = mkdtempSync(join(tmpdir(), "cleanup-session-test-"));
  const app = join(TMP, "app");
  const tmpRoot = join(TMP, "wtroot");
  mkdirSync(app, { recursive: true });
  const base = join(tmpRoot, sanitize(app), SESSION_ID);
  mkdirSync(base, { recursive: true });

  const g = (...a) => spawnSync("git", ["-C", app, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(app, "seed.txt"), "seed\n");
  g("add", ".");
  g("commit", "-qm", "seed");
  g("branch", `session/${SHORT}`, "main");
  g("branch", `${SHORT}/simple`, "main");
  g("worktree", "add", "-q", join(base, "_session"), `session/${SHORT}`);
  g("worktree", "add", "-q", join(base, "simple"), `${SHORT}/simple`);

  const promoteLock = join(app, ".promote.lock");
  const testResults = join(app, "test-results");
  writeFileSync(promoteLock, "");
  mkdirSync(testResults, { recursive: true });
  writeFileSync(join(testResults, ".last-run.json"), "{}");

  // The session's own log, which the teardown is about to destroy along with its home.
  const logFile = join(base, "hooks.log");
  writeFileSync(
    logFile,
    "[2026-09-01T10:00:00.000Z] [validate-on-stop] START role=dev\n",
  );
  // An isolated config dir, so the preserved copy lands somewhere the test owns rather
  // than in the developer's real ~/.claude.
  const configDir = join(TMP, "claude-config");
  const preserved = join(
    configDir,
    "projects",
    app.replace(/\//g, "-"),
    SESSION_ID,
    "hooks.log",
  );
  const env = {
    ...process.env,
    APP_DIR: app,
    HARNESS_TMP_ROOT: tmpRoot,
    CLAUDE_CONFIG_DIR: configDir,
  };
  delete env.CHAT_SESSION_DIR;
  const run = (extraEnv = {}) =>
    spawnSync("node", [HOOK], {
      input: JSON.stringify({ session_id: SESSION_ID }),
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
  const worktreeList = () => g("worktree", "list", "--porcelain").stdout;
  return {
    app,
    base,
    promoteLock,
    testResults,
    logFile,
    preserved,
    run,
    worktreeList,
  };
};

describe("cleanup-session", () => {
  // hooks.log used to die with the directory it lived in, on every single session. It is
  // the only record anywhere of a SubagentStop hook — a transcript carries PreToolUse,
  // PostToolUse, Stop and SessionStart with exact durations, and never a SubagentStop,
  // which is where the validation chain runs. So the chain could not be timed after the
  // fact, ever, and an archive of 78 real sessions held not one line of it.
  test("preserves hooks.log beside the session's transcripts", () => {
    const { base, logFile, preserved, run } = setup();
    expect(existsSync(logFile)).toBe(true);
    run();
    // The home is gone, and the log is not.
    expect(existsSync(base)).toBe(false);
    expect(existsSync(preserved)).toBe(true);
    expect(readFileSync(preserved, "utf8")).toContain("validate-on-stop");
  });

  test("a session with no log is torn down all the same", () => {
    const { base, logFile, preserved, run } = setup();
    rmSync(logFile, { force: true });
    const r = run();
    expect(r.status).toBe(0);
    expect(existsSync(base)).toBe(false);
    expect(existsSync(preserved)).toBe(false);
  });

  test("removes the session worktrees and base dir", () => {
    const { base, run, worktreeList } = setup();
    const r = run();
    expect(r.status).toBe(0);
    expect(existsSync(base)).toBe(false);
    // Only the main worktree remains registered.
    expect(worktreeList()).not.toContain("_session");
    expect(worktreeList()).not.toContain("/simple");
  });

  // The suite runs in the _session worktree, so the repo copy can only be a human's
  // `make test-e2e` output or a concurrent session's. Neither is this session's to drop.
  test("leaves the repo's Playwright test-results in place", () => {
    const { testResults, run } = setup();
    run();
    expect(existsSync(testResults)).toBe(true);
  });

  test("leaves the shared .promote.lock in place (concurrent-promotion mutex)", () => {
    const { promoteLock, run } = setup();
    run();
    expect(existsSync(promoteLock)).toBe(true);
  });

  test("removes only THIS session's rendered board, leaving other sessions'", () => {
    const { app, run } = setup();
    const mine = join(app, ".harness", SHORT);
    const other = join(app, ".harness", "beef9999");
    mkdirSync(mine, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(mine, "STATUS.md"), "# mine\n");
    writeFileSync(join(other, "STATUS.md"), "# other\n");
    run();
    expect(existsSync(mine)).toBe(false);
    expect(existsSync(other)).toBe(true);
  });

  test("leaves the main repo worktree intact", () => {
    const { app, run, worktreeList } = setup();
    run();
    expect(existsSync(join(app, "seed.txt"))).toBe(true);
    expect(worktreeList()).toContain(app);
  });

  test("preserves state for resume when a ticket is not yet merged (in-flight)", () => {
    const { base, run } = setup();
    writeFileSync(
      join(base, "TASK-001.json"),
      JSON.stringify({ id: "TASK-001", status: "planned" }),
    );
    const r = run();
    expect(r.status).toBe(0);
    // Teardown SKIPPED: the same session id must resume from disk later.
    expect(existsSync(base)).toBe(true);
    expect(existsSync(join(base, "TASK-001.json"))).toBe(true);
  });

  test("preserves state when the session branch has unpromoted commits", () => {
    const { base, run } = setup();
    const sessWt = join(base, "_session");
    writeFileSync(join(sessWt, "wave.txt"), "x\n");
    const gw = (...a) =>
      spawnSync("git", ["-C", sessWt, ...a], { encoding: "utf8" });
    gw("add", ".");
    gw("commit", "-qm", "wave work");
    const r = run();
    expect(r.status).toBe(0);
    expect(existsSync(base)).toBe(true);
  });

  test("is a no-op under a managed launcher (CHAT_SESSION_DIR set)", () => {
    const { base, promoteLock, run } = setup();
    const r = run({ CHAT_SESSION_DIR: "/tmp/managed-session-xyz" });
    expect(r.status).toBe(0);
    expect(existsSync(base)).toBe(true);
    expect(existsSync(promoteLock)).toBe(true);
  });
});

// A session preserved for resume keeps its whole dir, so anything a recovery run must NOT
// inherit has to be swept explicitly. The per-subagent Bash counters are that: those
// agents are gone, and their files would accumulate one per agent across every resume.
describe("cleanup-session: a preserved session sweeps the Bash counters", () => {
  const seedBreaker = (base) => {
    const dir = join(base, "breaker");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "bash-count-aaaa1111bbbb2222"), `${Date.now()}\n`);
    writeFileSync(join(dir, "bash-count-cccc3333dddd4444"), `${Date.now()}\n`);
    // Deliberate state a recovery run still reads: it must survive.
    writeFileSync(join(dir, "planner-eeee5555"), "orch\n");
    writeFileSync(join(dir, "completion-invariant-rejects"), "1");
    return dir;
  };

  test("counters go, the other markers stay", () => {
    const { base, run } = setup();
    const dir = seedBreaker(base);
    // An unmerged task branch is in-flight state, so the session is preserved.
    mkdirSync(join(base, "tickets"), { recursive: true });
    writeFileSync(
      join(base, "tickets", "TASK-001.json"),
      JSON.stringify({ ticket_id: "TASK-001", status: "pending" }),
    );

    const r = run();
    // The session must actually have been PRESERVED, or this proves nothing: the
    // non-preserved path removes the whole dir and the sweep never runs.
    expect(r.stderr).toContain("preserved for resume");
    expect(existsSync(dir)).toBe(true);

    const left = readdirSync(dir);
    expect(left.filter((f) => f.startsWith("bash-count-"))).toEqual([]);
    expect(left).toContain("planner-eeee5555");
    expect(left).toContain("completion-invariant-rejects");
  });
});
