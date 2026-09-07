// Tests for lib/io.mjs and ctx.flag: WHICH channel a hook writes on.
//
// This file exists because the harness got the channel wrong three times over and no test
// could see it. A hook that exits 1 with a message on stderr looks like a warning, passes
// any test that asserts its exit code and its stderr, and delivers nothing to the agent:
// the runtime files that as `hook_non_blocking_error` and shows it to the user only.
// Measured on Claude Code 2.1.263. So these tests assert the STDOUT CONTRACT, which is the
// only part the runtime reads back.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Run an inline script that builds a context and calls one of its terminal helpers. */
const runHelper = (body, payload) => {
  const dir = mkdtempSync(join(tmpdir(), "io-channels-"));
  const script = join(dir, "probe.mjs");
  writeFileSync(
    script,
    `import { readFileSync } from "node:fs";\n` +
      `import { createHookContext } from ${JSON.stringify(join(HERE, "..", "lib", "context.mjs"))};\n` +
      `const input = JSON.parse(readFileSync(0, "utf8"));\n` +
      `const ctx = createHookContext(input, "probe-hook");\n` +
      `${body}\n`,
  );
  const r = spawnSync("node", [script], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return r;
};

const POSTTOOLUSE = {
  session_id: "test-io-1",
  hook_event_name: "PostToolUse",
  tool_name: "Write",
  tool_input: { file_path: "/tmp/x.ts" },
};

describe("ctx.flag", () => {
  test("exits 0, because any non-zero exit discards the additionalContext channel", () => {
    const r = runHelper(`ctx.flag("something is off");`, POSTTOOLUSE);
    expect(r.status).toBe(0);
  });

  test("writes the message as hookSpecificOutput.additionalContext on stdout", () => {
    const r = runHelper(`ctx.flag("something is off");`, POSTTOOLUSE);
    const out = JSON.parse(r.stdout);
    expect(out.hookSpecificOutput.hookEventName).toBe("PostToolUse");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "something is off",
    );
  });

  test("names the hook in the message, so the agent knows what spoke", () => {
    const r = runHelper(`ctx.flag("something is off");`, POSTTOOLUSE);
    expect(JSON.parse(r.stdout).hookSpecificOutput.additionalContext).toContain(
      "[probe-hook]",
    );
  });

  test("puts nothing on stderr, the channel the agent does not read", () => {
    const r = runHelper(`ctx.flag("something is off");`, POSTTOOLUSE);
    expect(r.stderr).toBe("");
  });

  test("echoes back the event name from the payload", () => {
    const r = runHelper(`ctx.flag("careful");`, {
      ...POSTTOOLUSE,
      hook_event_name: "PreToolUse",
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe(
      "PreToolUse",
    );
  });

  test("falls back to PostToolUse when the payload names no event", () => {
    const r = runHelper(`ctx.flag("careful");`, {
      session_id: "test-io-1",
      tool_name: "Write",
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe(
      "PostToolUse",
    );
  });

  test("emits one line of parseable JSON and nothing else", () => {
    const r = runHelper(`ctx.flag("line one\\nline two");`, POSTTOOLUSE);
    const lines = r.stdout.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0])).not.toThrow();
    expect(JSON.parse(lines[0]).hookSpecificOutput.additionalContext).toContain(
      "line two",
    );
  });
});

describe("ctx.fail, the blocking channel, is unchanged", () => {
  test("exits 2 and writes to stderr, which the runtime does forward when blocking", () => {
    const r = runHelper(`ctx.fail("no");`, POSTTOOLUSE);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no");
    expect(r.stdout).toBe("");
  });
});

describe("ctx.block, the PreToolUse deny channel, is unchanged", () => {
  test("exits 0 with a decision block on stdout", () => {
    const r = runHelper(`ctx.block({ reason: "denied" });`, POSTTOOLUSE);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout);
    expect(out.decision).toBe("block");
    expect(out.reason).toBe("denied");
  });
});
