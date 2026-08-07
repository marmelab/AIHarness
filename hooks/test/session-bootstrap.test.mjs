// Tests for session-bootstrap.mjs — the SessionStart hook that injects
// <session_dir> via hookSpecificOutput.additionalContext so the harness can run
// on any surface without a launch script. Key invariant: the injected dir is
// ctx.sessionDir = <TMP_ROOT>/<sanitized repo>/<session_id>, so its basename is
// the real session id (what setup-worktree and the orchestrator also key off).

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, test, expect } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "session-bootstrap.mjs");
const TMP = mkdtempSync(join(tmpdir(), "session-bootstrap-test-"));
const APP_DIR = join(TMP, "repo");
const HARNESS_TMP_ROOT = join(TMP, "scratch");
const SESSION_ID = "abcd1234-1111-2222-3333-444455556666";

const baseEnv = { ...process.env, APP_DIR, HARNESS_TMP_ROOT };
delete baseEnv.CHAT_SESSION_DIR;
delete baseEnv.CLAUDE_CODE_SESSION_ID;

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const run = (payload, extraEnv = {}) =>
  spawnSync("node", [HOOK], {
    input: payload === undefined ? "" : JSON.stringify(payload),
    env: { ...baseEnv, ...extraEnv },
    encoding: "utf8",
  });

describe("session-bootstrap", () => {
  test("injects <session_dir> built from the real session id", () => {
    const r = run({ session_id: SESSION_ID });
    expect(r.status).toBe(0);
    const expectedDir = join(
      HARNESS_TMP_ROOT,
      sanitizePath(APP_DIR),
      SESSION_ID,
    );
    expect(r.stdout).toContain(`<session_dir>${expectedDir}</session_dir>`);
    // Alignment invariant: basename(session_dir) === session_id.
    const m = r.stdout.match(/<session_dir>(.+?)<\/session_dir>/);
    expect(m && m[1].split("/").pop()).toBe(SESSION_ID);
  });

  test("emits valid additionalContext JSON for SessionStart", () => {
    const r = run({ session_id: SESSION_ID });
    const parsed = JSON.parse(r.stdout.trim());
    expect(parsed.hookSpecificOutput.hookEventName).toBe("SessionStart");
    expect(parsed.hookSpecificOutput.additionalContext).toContain(
      "<session_dir>",
    );
  });

  test("stays out of the way when a managed launcher owns the session", () => {
    const r = run(
      { session_id: SESSION_ID },
      { CHAT_SESSION_DIR: "/tmp/managed-launcher/session" },
    );
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("<session_dir>");
  });

  test("exits cleanly with no output when there is no payload", () => {
    const r = run(undefined);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("<session_dir>");
  });

  test("emits no resume banner for a fresh session with no harness state", () => {
    const r = run({ session_id: SESSION_ID });
    expect(r.stdout).not.toContain("<harness_resume>");
  });

  test("injects a resume banner when THIS session has in-flight harness state", () => {
    // An unmerged ticket in the session dir = an interrupted plan-gate session.
    // Isolated app/scratch so the shared module-level dirs stay banner-free.
    const app = mkdtempSync(join(tmpdir(), "sb-inflight-app-"));
    const scratch = mkdtempSync(join(tmpdir(), "sb-inflight-scratch-"));
    const sid = "beef1234-aaaa-bbbb-cccc-ddddeeeeffff";
    const sessionDir = join(scratch, sanitizePath(app), sid);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      join(sessionDir, "TASK-001.json"),
      JSON.stringify({ id: "TASK-001", status: "planned" }),
    );
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({ session_id: sid }),
      env: { ...baseEnv, APP_DIR: app, HARNESS_TMP_ROOT: scratch },
      encoding: "utf8",
    });
    rmSync(app, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("<harness_resume>");
    expect(r.stdout).toContain("plan gate");
    // The banner is appended, not a replacement: <session_dir> is still present.
    expect(r.stdout).toContain("<session_dir>");
  });
});

// A subagent's shell was observed with an EMPTY $CLAUDE_PROJECT_DIR, and under plugin
// distribution the harness scripts are not under the project's .claude/ at all. So the
// paths are resolved here, where the env is right, and written for the agents to source.
describe("harness-env.sh", () => {
  const sessionDir = () =>
    join(HARNESS_TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);

  const exported = (name) => {
    const body = readFileSync(join(sessionDir(), "harness-env.sh"), "utf8");
    return (body.match(new RegExp(`export ${name}="([^"]+)"`)) || [])[1];
  };

  // The plugin layout: the scripts live in the plugin, NOT under the project's .claude/,
  // which is exactly what the hand-spelled path in the prompts got wrong.
  test("resolves the plugin's scripts dir when installed as a plugin", () => {
    const pluginRoot = join(HERE, "..", "..");
    run({ session_id: SESSION_ID }, { CLAUDE_PLUGIN_ROOT: pluginRoot });
    const scripts = exported("HARNESS_SCRIPTS");
    expect(isAbsolute(scripts)).toBe(true);
    expect(existsSync(join(scripts, "pending-deploys.mjs"))).toBe(true);
  });

  // The copied-into-project layout: <repo>/.claude/scripts.
  test("resolves the project's .claude/scripts when copied in", () => {
    const scriptsDir = join(APP_DIR, ".claude", "scripts");
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(join(scriptsDir, "e2e-smoke.sh"), "#!/usr/bin/env bash\n");
    const env = { ...baseEnv };
    delete env.CLAUDE_PLUGIN_ROOT;
    spawnSync("node", [HOOK], {
      input: JSON.stringify({ session_id: SESSION_ID }),
      env,
      encoding: "utf8",
    });
    expect(exported("HARNESS_SCRIPTS")).toBe(scriptsDir);
    rmSync(join(APP_DIR, ".claude"), { recursive: true, force: true });
  });

  test("the repo root is absolute, and is not the empty string", () => {
    run({ session_id: SESSION_ID });
    expect(exported("HARNESS_REPO")).toBe(APP_DIR);
    expect(isAbsolute(exported("HARNESS_REPO"))).toBe(true);
  });

  test("is valid shell, and sourcing it exports the three variables", () => {
    run({ session_id: SESSION_ID });
    const r = spawnSync(
      "bash",
      [
        "-c",
        `source ${JSON.stringify(join(sessionDir(), "harness-env.sh"))} && echo "$HARNESS_SCRIPTS|$HARNESS_REPO|$HARNESS_SESSION_DIR"`,
      ],
      { encoding: "utf8" },
    );
    expect(r.status).toBe(0);
    const [scripts, repo, session] = r.stdout.trim().split("|");
    expect(scripts).toBeTruthy();
    expect(repo).toBeTruthy();
    expect(session).toBe(sessionDir());
  });
});
