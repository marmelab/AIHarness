// Tests for hook-chain.mjs — what happens to the chain, and to the tool call, when one
// guard throws. The regression these pin: a crashed guard used to be reported only in
// hooks.log, which made it indistinguishable from a guard that had no opinion.

import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, test, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHAIN = join(HERE, "..", "lib", "hook-chain.mjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "hook-chain-tmp-"));
const fixtureDir = mkdtempSync(join(tmpdir(), "hook-chain-fixture-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(fixtureDir, { recursive: true, force: true });
});

const SESSION_ID = "chain-test-1";

// A chain whose guards are described by `spec`: "throw" raises, "block" refuses,
// "noop" returns. Written to disk and spawned, so the process-level behavior (exit
// code, stdout decision, stderr) is what the test observes.
const runFixture = (spec) => {
  const guards = spec
    .map(([name, kind]) => {
      const body =
        kind === "throw"
          ? `() => { throw new ReferenceError("boom in ${name}"); }`
          : kind === "block"
            ? `(input, ctx) => ctx.block({ reason: "refused by ${name}" })`
            : `() => {}`;
      return `["${name}", ${body}]`;
    })
    .join(", ");
  const file = join(fixtureDir, `chain-${spec.map(([, k]) => k).join("-")}.mjs`);
  writeFileSync(
    file,
    `import { runChain } from ${JSON.stringify(CHAIN)};\nrunChain([${guards}]);\n`,
  );
  const env = { ...process.env, HARNESS_TMP_ROOT: tmpRoot };
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync("node", [file], {
    input: JSON.stringify({
      tool_name: "Bash",
      session_id: SESSION_ID,
      tool_input: { command: "git status" },
    }),
    env,
    encoding: "utf8",
  });
};

const isBlocked = (r) => r.stdout.includes('"decision":"block"');

describe("runChain", () => {
  test("a crashing guard is reported on stderr, not only in hooks.log", () => {
    const r = runFixture([["crasher", "throw"]]);
    expect(r.stderr).toContain("[crasher]");
    expect(r.stderr).toContain("guard crashed, its rules did NOT run");
    expect(r.stderr).toContain("boom in crasher");
  });

  test("the crash is still recorded in hooks.log too", () => {
    runFixture([["crasher", "throw"]]);
    // The session dir layout under HARNESS_TMP_ROOT is the context module's business,
    // so find the log rather than rebuild its path here.
    const logs = readdirSync(tmpRoot, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name === "hooks.log")
      .map((d) => readFileSync(join(d.parentPath ?? d.path, d.name), "utf8"));
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("")).toContain("[crasher] ERROR");
  });

  test("a crash is fail-OPEN: exit 0 and no block decision", () => {
    const r = runFixture([["crasher", "throw"]]);
    expect(r.status).toBe(0);
    expect(isBlocked(r)).toBe(false);
  });

  test("a later guard still refuses after an earlier one crashed", () => {
    const r = runFixture([
      ["crasher", "throw"],
      ["gate", "block"],
    ]);
    expect(r.status).toBe(0);
    expect(isBlocked(r)).toBe(true);
    expect(r.stdout).toContain("refused by gate");
    expect(r.stderr).toContain("guard crashed");
  });

  test("a clean chain reports nothing and allows the call", () => {
    const r = runFixture([
      ["quiet", "noop"],
      ["also-quiet", "noop"],
    ]);
    expect(r.status).toBe(0);
    expect(isBlocked(r)).toBe(false);
    expect(r.stderr).toBe("");
  });
});
