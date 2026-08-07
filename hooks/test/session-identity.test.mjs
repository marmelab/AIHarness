// A hook context REQUIRES a session id.
//
// Every marker the harness owns is keyed on it: the breaker counters, the review
// verdict flags, the validation give-up markers, the worktree base. The old fallback
// put two id-less contexts in the same /tmp/<repo>/default/, where one session's
// breaker budget throttles another's agent and one session's APPROVED flag lets
// another's merger through. That is a collision, not a default.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const hook = (name) => join(HERE, "..", `${name}.mjs`);

let TMP, APP_DIR, TMP_ROOT, env;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "session-identity-"));
  APP_DIR = join(TMP, "app");
  TMP_ROOT = join(TMP, "scratch");
  mkdirSync(APP_DIR, { recursive: true });
  mkdirSync(TMP_ROOT, { recursive: true });
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  // Every source of a session id, cleared: the point is what happens with none.
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

const defaultDir = () => join(TMP_ROOT, sanitizePath(APP_DIR), "default");

describe("createHookContext with no session id", () => {
  test("refuses to build a context instead of sharing one", () => {
    const r = spawnSync(
      "node",
      [
        "-e",
        `import(${JSON.stringify(join(HERE, "..", "lib", "context.mjs"))}).then((m) => {
           try {
             m.createHookContext({}, "probe");
             console.log("NO THROW");
           } catch (e) {
             console.log("THREW: " + e.message);
           }
         })`,
      ],
      { env, encoding: "utf8" },
    );
    expect(r.stdout).toContain("THREW:");
    expect(r.stdout).toContain("no session id");
  });

  test("still builds one from CLAUDE_CODE_SESSION_ID alone", () => {
    const r = spawnSync(
      "node",
      [
        "-e",
        `import(${JSON.stringify(join(HERE, "..", "lib", "context.mjs"))}).then((m) =>
           console.log(m.createHookContext({}, "probe").sessionId))`,
      ],
      { env: { ...env, CLAUDE_CODE_SESSION_ID: "from-env" }, encoding: "utf8" },
    );
    expect(r.stdout.trim()).toBe("from-env");
  });
});

describe("a PreToolUse chain with no session id", () => {
  const payload = {
    tool_name: "Bash",
    agent_type: "developer",
    tool_input: { command: "echo hello" },
  };

  test("reports the failure and lets the call through", () => {
    const r = spawnSync("node", [hook("pre-tool-bash")], {
      input: JSON.stringify(payload),
      env,
      encoding: "utf8",
    });
    // Fail open on ignorance: the tool call is not denied.
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('"decision":"block"');
    // Loud: the reason is on the one channel still available.
    expect(r.stderr).toContain("no session id");
    expect(r.stderr).toContain("[bash-guard]");
  });

  // The collision this replaces: a counted Bash call writes a breaker counter, and
  // under the old fallback two unrelated sessions wrote theirs to the same file.
  test("writes no breaker counter into a shared default session dir", () => {
    spawnSync("node", [hook("pre-tool-bash")], {
      input: JSON.stringify({ ...payload, agent_id: "a1111111111111111" }),
      env,
      encoding: "utf8",
    });
    expect(existsSync(join(defaultDir(), "breaker"))).toBe(false);
    expect(existsSync(defaultDir())).toBe(false);
  });
});
