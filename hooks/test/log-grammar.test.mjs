// hooks.log has one grammar: `[timestamp] [hook] message`, one line per event. It is
// what makes the file greppable, and three things broke it.
//
//   1. A validation failure logged twice, once with wt= and once bare, so a grep for
//      FAIL counted every failure as two.
//   2. Raw compiler / test-runner output appended to a log line, leaving hundreds of
//      continuation lines with no timestamp and no hook name.
//   3. ANSI colour escapes inside those lines, which make every later grep and diff of
//      the file unreadable.

import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { forLog, stripAnsi } from "../lib/log-output.mjs";
import { sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const ESC = String.fromCharCode(27);
const HERE = dirname(fileURLToPath(import.meta.url));
const VALIDATE = join(HERE, "..", "validate-on-stop.mjs");
const SESSION_ID = "109g4a11-1111-2222-3333-444455556666";

describe("forLog", () => {
  test("strips ANSI colour and cursor escapes", () => {
    const colored = `${ESC}[31merror${ESC}[0m TS2345: bad argument`;
    expect(stripAnsi(colored)).toBe("error TS2345: bad argument");
    expect(forLog(colored)).toBe("error TS2345: bad argument");
  });

  test("keeps the tail, where a compiler and a test runner put the summary", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line${i}`).join("\n");
    const out = forLog(long, { maxLines: 5 });
    expect(out).toContain("line39");
    expect(out).not.toContain("line10");
    // A short log line must never be mistaken for short output.
    expect(out).toContain("35 earlier line(s) omitted");
  });

  test("bounds the character count too", () => {
    expect(forLog("x".repeat(5000), { maxChars: 100 }).length).toBeLessThan(
      120,
    );
  });

  test("blank or absent output logs nothing at all", () => {
    expect(forLog("")).toBe("");
    expect(forLog("\n\n  \n")).toBe("");
    expect(forLog(undefined)).toBe("");
  });
});

describe("ctx.log with a multi-line payload", () => {
  let TMP, APP_DIR, sessionDir, env, probe;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "log-grammar-ctx-"));
    APP_DIR = join(TMP, "app");
    const TMP_ROOT = join(TMP, "scratch");
    sessionDir = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
    mkdirSync(APP_DIR, { recursive: true });
    env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
    delete env.CHAT_SESSION_DIR;
    probe = join(TMP, "probe.mjs");
    // A compiler's output as it actually arrives: several lines, coloured.
    writeFileSync(
      probe,
      `import { createHookContext } from ${JSON.stringify(join(HERE, "..", "lib", "context.mjs"))};
       import { forLog } from ${JSON.stringify(join(HERE, "..", "lib", "log-output.mjs"))};
       const ESC = String.fromCharCode(27);
       const raw = [
         ESC + "[31msrc/a.ts(3,7): error TS2345: bad" + ESC + "[0m",
         ESC + "[31msrc/b.ts(9,1): error TS2551: nope" + ESC + "[0m",
         "",
         "Found 2 errors.",
       ].join("\\n");
       const ctx = createHookContext({ session_id: ${JSON.stringify(SESSION_ID)} }, "probe");
       ctx.log("STEP-FAIL step=typecheck\\n" + forLog(raw));`,
    );
  });

  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  test("prefixes every line and strips the escapes", () => {
    const r = spawnSync("node", [probe], { env, encoding: "utf8" });
    expect(r.status).toBe(0);
    const body = readFileSync(join(sessionDir, "hooks.log"), "utf8");
    expect(body).not.toContain(ESC);
    const lines = body.split("\n").filter((l) => l.trim());
    expect(lines.length).toBe(4); // the STEP-FAIL line plus three output lines
    for (const line of lines) {
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[probe\] /);
    }
    expect(lines[1]).toContain("error TS2345");
    expect(lines[3]).toContain("Found 2 errors.");
  });
});

describe("a failing validation chain", () => {
  let TMP, APP_DIR, sessionDir, env, layout;

  beforeEach(() => {
    TMP = mkdtempSync(join(tmpdir(), "log-grammar-"));
    APP_DIR = join(TMP, "app");
    const TMP_ROOT = join(TMP, "scratch");
    sessionDir = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
    mkdirSync(sessionDir, { recursive: true });
    mkdirSync(join(APP_DIR), { recursive: true });
    // A REAL failing step, emitting what a compiler emits: several lines, coloured.
    // The dry-run shortcut returns a fixed one-line string, which would let the ANSI
    // and multi-line assertions below pass without exercising anything.
    writeFileSync(
      join(APP_DIR, "harness.config.json"),
      JSON.stringify({
        validation: {
          steps: [
            {
              id: "typecheck",
              kind: "typecheck",
              command:
                "printf '\\033[31msrc/a.ts(3,7): error TS2345: bad\\033[0m\\n" +
                "src/b.ts(9,1): error TS2551: nope\\nFound 2 errors.\\n'; exit 1",
            },
          ],
        },
        roles: { developer: { model: "sonnet", validate: true } },
      }),
    );
    // The worktree the stop owns: a git repo with an uncommitted change, which is what
    // makes the chain consider it worth validating.
    const wt = join(sessionDir, "TASK-001");
    mkdirSync(wt, { recursive: true });
    const g = (...a) =>
      spawnSync("git", ["-C", wt, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    writeFileSync(join(wt, "seed.txt"), "seed\n");
    g("add", "-A");
    g("commit", "-qm", "seed");
    writeFileSync(join(wt, "seed.txt"), "changed\n");
    env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
    delete env.CLAUDE_AGENT_NAME;
    delete env.CHAT_SESSION_DIR;
    layout = runtimeLayout(join(TMP, "rt"), SESSION_ID);
    spawnAgent(
      layout,
      "a10999999999999991",
      { agentType: "developer", description: "Implement TASK-001" },
      "ROLE: developer\nTASK_ID: TASK-001\n",
    );
  });

  afterEach(() => rmSync(TMP, { recursive: true, force: true }));

  const runStop = () =>
    spawnSync("node", [VALIDATE], {
      input: JSON.stringify(stopPayload(layout, "a10999999999999991")),
      env,
      encoding: "utf8",
    });

  const logLines = () =>
    readFileSync(join(sessionDir, "hooks.log"), "utf8")
      .split("\n")
      .filter((l) => l.trim());

  test("says FAIL exactly once, and that line carries the worktree", () => {
    const r = runStop();
    expect(r.status).toBe(2);
    // Not vacuous: the step really ran and really failed.
    expect(r.stderr).toContain("error TS2345");
    const fails = logLines().filter((l) => / \[validate\] FAIL /.test(l));
    expect(fails.length).toBe(1);
    expect(fails[0]).toContain("wt=");
    expect(fails[0]).toContain("step=typecheck");
  });

  // Every line, including the continuation lines of the captured output.
  test("leaves no line without a timestamp and a hook name", () => {
    runStop();
    for (const line of logLines()) {
      expect(line).toMatch(/^\[\d{4}-\d{2}-\d{2}T[\d:.]+Z\] \[[a-z-]+\] /);
    }
  });

  test("writes no ANSI escapes into the log", () => {
    runStop();
    expect(readFileSync(join(sessionDir, "hooks.log"), "utf8")).not.toContain(
      ESC,
    );
  });
});
