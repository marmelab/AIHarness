// Session-scoped state REQUIRES a session id; a hook context does not.
//
// Every marker the harness owns is keyed on the id: the breaker counters, the review
// verdict flags, the validation give-up markers, the worktree base. The old fallback put
// two id-less contexts in the same /tmp/<repo>/default/, where one session's breaker
// budget throttles another's agent and one session's APPROVED flag lets another's merger
// through. That is a collision, not a default.
//
// The refusal therefore sits on the STATE, not on the context. Refusing the context
// itself takes guards offline that never touch session state (both documentator
// restrictions only report a refusal on stderr) to protect markers they never write.

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
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const hook = (name) => join(HERE, "..", `${name}.mjs`);
const CONTEXT = join(HERE, "..", "lib", "context.mjs");

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

// Read one member of a context built with no session id, and report what happened.
const readMember = (member, extraEnv = {}) => {
  const probe = join(TMP, `probe-${member}.mjs`);
  writeFileSync(
    probe,
    `import { createHookContext } from ${JSON.stringify(CONTEXT)};
     const ctx = createHookContext({}, "probe");
     try {
       console.log("VALUE " + ctx[${JSON.stringify(member)}]);
     } catch (e) {
       console.log("THREW " + e.message);
     }`,
  );
  return spawnSync("node", [probe], {
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  }).stdout;
};

describe("a context built with no session id", () => {
  test.each([
    "sessionId",
    "sessionShort",
    "sessionDir",
    "worktreeBase",
    "logFile",
    "ticketsDir",
  ])("refuses to hand out %s", (member) => {
    const out = readMember(member);
    expect(out).toContain("THREW");
    expect(out).toContain("no session id");
  });

  // The members that say who is calling, not where their state lives, still answer:
  // a guard that only reports a refusal has nothing to collide over.
  test.each(["name", "repo"])("still answers %s", (member) => {
    expect(readMember(member)).toContain("VALUE ");
  });

  test("resolves normally from CLAUDE_CODE_SESSION_ID alone", () => {
    expect(
      readMember("sessionId", { CLAUDE_CODE_SESSION_ID: "from-env" }),
    ).toBe("VALUE from-env\n");
  });
});

// The regression this shape exists to prevent: these two guards need no session state,
// and an earlier version of the refusal took them offline in any environment that does
// not export CLAUDE_CODE_SESSION_ID, which is every CI run and every plain shell.
describe("a guard that needs no session state still runs", () => {
  test("restrict-documentator-write refuses a forbidden path", () => {
    const r = spawnSync("node", [hook("restrict-documentator-write")], {
      input: JSON.stringify({
        tool_name: "Write",
        tool_input: { file_path: "/app/src/index.ts" },
      }),
      env: { ...env, DOCUMENTATOR_RUN: "1" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });

  test("restrict-documentator-bash refuses a non-whitelisted command", () => {
    const r = spawnSync("node", [hook("pre-tool-bash")], {
      input: JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: "rm -rf /" },
      }),
      env: { ...env, DOCUMENTATOR_RUN: "1" },
      encoding: "utf8",
    });
    expect(r.status).toBe(2);
  });
});

describe("a PreToolUse chain whose guard reaches for session state", () => {
  // circuit-breaker keys its counter on the session dir, so this is the call that
  // actually needs an id.
  const payload = {
    tool_name: "Bash",
    agent_type: "developer",
    agent_id: "a1111111111111111",
    tool_input: { command: "npm install lodash" },
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
    expect(r.stderr).toContain("[circuit-breaker]");
  });

  test("writes no breaker counter into a shared default session dir", () => {
    spawnSync("node", [hook("pre-tool-bash")], {
      input: JSON.stringify(payload),
      env,
      encoding: "utf8",
    });
    expect(existsSync(join(defaultDir(), "breaker"))).toBe(false);
    expect(existsSync(defaultDir())).toBe(false);
  });
});
