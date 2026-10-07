// Tests for keeping hooks.log alive.
//
// The file is written into the session directory, which is also `worktreeBase`, which
// cleanup-session deletes whole. So the harness destroyed the log of its own guards on
// every session, and an archive of 78 real sessions held not one line of it. That is not a
// cosmetic loss: a transcript records PreToolUse, PostToolUse, Stop and SessionStart with
// exact durations and NEVER a SubagentStop, which is the event the validation chain runs
// on. hooks.log is the only place a typecheck or a test suite leaves any trace at all, and
// every line carries its own timestamp, so the chain can be timed from it exactly.
//
// It is mirrored at two moments and both are needed. SessionEnd takes the complete copy but
// only fires on a clean end (`clear`, `resume`, `logout`, `prompt_input_exit`, `other`) and
// promises nothing about a crash or a closed terminal; Stop runs after every turn and is at
// most one turn stale.
//
// Driven through spawnSync like the other hook tests: paths.mjs reads its roots from the
// environment once, at import, so the module has to meet that environment in a fresh
// process rather than have it set around an import.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = join(HERE, "..", "turn-complete.mjs");
const SESSION_ID = "beef1234-1111-2222-3333-444455556666";
const sanitize = (p) => p.replace(/\//g, "_");
const slug = (p) => p.replace(/\//g, "-");
const LINE =
  "[2026-09-01T10:00:00.000Z] [validate-on-stop] START role=developer\n";

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

const setup = ({ line = LINE } = {}) => {
  TMP = mkdtempSync(join(tmpdir(), "hooks-log-test-"));
  const repo = join(TMP, "app");
  const tmpRoot = join(TMP, "wtroot");
  const configDir = join(TMP, "claude-config");
  mkdirSync(repo, { recursive: true });
  const sessionDir = join(tmpRoot, sanitize(repo), SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  const live = join(sessionDir, "hooks.log");
  if (line !== null) writeFileSync(live, line);

  // Where Claude Code already keeps this session's subagent transcripts and tool results.
  const sidecar = join(configDir, "projects", slug(repo), SESSION_ID);
  const preserved = join(sidecar, "hooks.log");

  const env = {
    ...process.env,
    APP_DIR: repo,
    HARNESS_TMP_ROOT: tmpRoot,
    CLAUDE_CONFIG_DIR: configDir,
  };
  delete env.CHAT_SESSION_DIR;
  const stop = () =>
    spawnSync("node", [STOP_HOOK], {
      input: JSON.stringify({ session_id: SESSION_ID }),
      env,
      encoding: "utf8",
    });
  return { repo, live, sidecar, preserved, stop };
};

describe("the Stop hook mirrors hooks.log", () => {
  test("a turn leaves the log preserved, so a crash cannot take it", () => {
    const { preserved, stop } = setup();
    const r = stop();
    expect(r.status).toBe(0);
    expect(existsSync(preserved)).toBe(true);
    expect(readFileSync(preserved, "utf8")).toContain("validate-on-stop");
  });

  test("it lands beside the subagent transcripts, not in a place of its own", () => {
    // Which is what makes it archived for free: anything that collects a session's
    // transcripts copies this directory whole.
    const { sidecar, preserved, stop } = setup();
    stop();
    expect(preserved).toBe(join(sidecar, "hooks.log"));
    expect(existsSync(sidecar)).toBe(true);
  });

  test("a session with no log is not an error", () => {
    // The hook is inert by default and has to stay inert.
    const { preserved, stop } = setup({ line: null });
    const r = stop();
    expect(r.status).toBe(0);
    expect(existsSync(preserved)).toBe(false);
  });

  test("an unchanged log is not copied again", () => {
    // Stop fires on every turn and most turns add no line. Re-copying an unchanged file
    // hundreds of times a session is work nobody asked for.
    const { preserved, stop } = setup();
    stop();
    const first = statSync(preserved).mtimeMs;
    stop();
    expect(statSync(preserved).mtimeMs).toBe(first);
  });

  test("a log that grew is copied again", () => {
    const { live, preserved, stop } = setup();
    stop();
    writeFileSync(
      live,
      LINE + "[2026-09-01T10:01:00.000Z] [bash-guard] BLOCKED e2e\n",
    );
    stop();
    expect(readFileSync(preserved, "utf8")).toContain("bash-guard");
  });
});
