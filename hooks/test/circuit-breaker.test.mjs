// Tests for circuit-breaker.mjs: the per-subagent WORK-call budget.
//
// The budget is a SLIDING WINDOW, and the reason is the whole point of this file. A
// lifetime counter cannot tell a stuck agent from a long-lived one, so it blocked an
// orchestrator that had been working steadily for nearly two hours, during its final
// mandated step. A loop reaches the limit in minutes; paced work never does, however long
// the agent lives.
//
// Blocks are decision JSON on stdout with exit 0. The main session (no agent_id) is never
// throttled. What counts is decided by lib/bash-classify.mjs, tested separately.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, test, expect } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "circuit-breaker.mjs");
const SESSION_ID = "cb-1234";
const WORK = "node work.mjs";

const tmpRoot = mkdtempSync(join(tmpdir(), "circuit-breaker-tmp-"));
const appDir = mkdtempSync(join(tmpdir(), "circuit-breaker-app-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(appDir, { recursive: true, force: true });
});

const breakerDir = join(tmpRoot, sanitizePath(appDir), SESSION_ID, "breaker");
const counterFile = (agentId) =>
  join(
    breakerDir,
    `bash-count-${createHash("sha1").update(`sub-${agentId}`).digest("hex").slice(0, 16)}`,
  );

// Seed the window with calls that happened N minutes ago, which is how a spread-out
// timeline is expressed without the test waiting for it.
const seedAgo = (agentId, minutesAgo = []) => {
  mkdirSync(breakerDir, { recursive: true });
  writeFileSync(
    counterFile(agentId),
    minutesAgo.map((m) => Date.now() - m * 60_000).join("\n") + "\n",
  );
};

const runHook = (agentId, command = WORK, extraEnv = {}) => {
  const env = {
    ...process.env,
    HARNESS_TMP_ROOT: tmpRoot,
    APP_DIR: appDir,
    ...extraEnv,
  };
  delete env.CLAUDE_AGENT_NAME;
  const payload = {
    tool_name: "Bash",
    session_id: SESSION_ID,
    tool_input: { command },
  };
  if (agentId) payload.agent_id = agentId;
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    env,
    encoding: "utf8",
  });
};

const isBlocked = (r) => r.stdout.includes('"decision":"block"');

describe("who is throttled at all", () => {
  test("the main session (no agent_id) never is", () => {
    let last;
    for (let i = 0; i < 60; i++) last = runHook("", WORK);
    expect(last.status).toBe(0);
    expect(isBlocked(last)).toBe(false);
  });

  test("each subagent has its own window", () => {
    for (let i = 1; i <= 31; i++) runHook("agent-busy", WORK);
    expect(isBlocked(runHook("agent-fresh", WORK))).toBe(false);
  });
});

describe("the window bounds a burst, not a lifetime", () => {
  test("a burst past the limit blocks", () => {
    let r;
    for (let i = 1; i <= 30; i++) r = runHook("agent-burst", WORK);
    expect(isBlocked(r)).toBe(false); // 30 in the window is still allowed
    const blocked = runHook("agent-burst", WORK); // the 31st
    expect(isBlocked(blocked)).toBe(true);
    expect(blocked.stdout).toContain("loop rather than progress");
  });

  // The measured failure: 46 calls at roughly one every 2.4 minutes, over nearly two
  // hours. A lifetime budget of 45 blocked the 46th; a window never sees more than a
  // handful at once.
  test("46 calls paced over two hours never block", () => {
    const paced = Array.from({ length: 45 }, (_, i) => (45 - i) * 2.4);
    seedAgo("agent-paced", paced);
    expect(isBlocked(runHook("agent-paced", WORK))).toBe(false);
  });

  test("calls older than the window stop counting", () => {
    // 40 calls, all more than ten minutes ago: the window is empty again.
    seedAgo(
      "agent-aged",
      Array.from({ length: 40 }, (_, i) => 11 + i),
    );
    expect(isBlocked(runHook("agent-aged", WORK))).toBe(false);
  });

  test("a blocked agent frees itself as its calls age out", () => {
    seedAgo(
      "agent-recovering",
      Array.from({ length: 31 }, () => 0.1),
    );
    expect(isBlocked(runHook("agent-recovering", WORK))).toBe(true);
    // The same 31 calls, now just past the window.
    seedAgo(
      "agent-recovering",
      Array.from({ length: 31 }, () => 10.5),
    );
    expect(isBlocked(runHook("agent-recovering", WORK))).toBe(false);
  });

  test("the window is configurable, and a tighter one blocks sooner", () => {
    const env = { BREAKER_WINDOW_LIMIT: "3" };
    let r;
    for (let i = 1; i <= 3; i++) r = runHook("agent-tight", WORK, env);
    expect(isBlocked(r)).toBe(false);
    expect(isBlocked(runHook("agent-tight", WORK, env))).toBe(true);
  });
});

describe("what the window counts", () => {
  test("read-only exploration never fills it", () => {
    let last;
    for (const cmd of [
      "grep -rn Foo src",
      "L=x; grep -rn $L src | awk '{print $1}' | sort -u",
      "( cd /tmp/wt && find . -name '*.ts' )",
      "for f in a b; do cat $f; done",
    ]) {
      for (let i = 0; i < 20; i++) last = runHook("agent-explore", cmd);
    }
    expect(isBlocked(last)).toBe(false); // 80 read-only calls
  });

  test("git plumbing and the final commit are never starved", () => {
    let last;
    for (let i = 0; i < 60; i++)
      last = runHook("agent-commit", 'git commit -m "feat(TASK-001): x"');
    expect(isBlocked(last)).toBe(false);
  });

  // The technical persona REQUIRES an append per step. Over 30 of the 46 calls that
  // exhausted the old budget were these.
  test("progress-log appends are never counted", () => {
    let last;
    for (let i = 0; i < 60; i++)
      last = runHook(
        "agent-progress",
        `echo "[wave] step ${i}" >> /tmp/s/harness-progress.log`,
      );
    expect(isBlocked(last)).toBe(false);
  });

  test("free calls leave the work budget untouched", () => {
    for (let i = 0; i < 60; i++) runHook("agent-mixed", "grep -rn Foo src");
    let r;
    for (let i = 1; i <= 30; i++) r = runHook("agent-mixed", WORK);
    expect(isBlocked(r)).toBe(false);
    expect(isBlocked(runHook("agent-mixed", WORK))).toBe(true);
  });
});

describe("bookkeeping", () => {
  test("the counter file keeps only the window, so it cannot grow forever", () => {
    seedAgo(
      "agent-bounded",
      Array.from({ length: 50 }, (_, i) => 11 + i),
    );
    runHook("agent-bounded", WORK);
    const lines = readFileSync(counterFile("agent-bounded"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1); // the 50 aged-out entries were dropped
  });

  // The old format was a single lifetime integer. It must not read as a timestamp, or an
  // upgrade would carry a bogus entry into the new window.
  test("a counter file in the old format is discarded, not misread", () => {
    mkdirSync(breakerDir, { recursive: true });
    writeFileSync(counterFile("agent-legacy"), "45");
    expect(isBlocked(runHook("agent-legacy", WORK))).toBe(false);
    const lines = readFileSync(counterFile("agent-legacy"), "utf8")
      .split("\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test("a free call writes nothing at all", () => {
    runHook("agent-quiet", "grep -rn Foo src");
    expect(existsSync(counterFile("agent-quiet"))).toBe(false);
  });

  // ctx.block already prefixes the verb, so a log line starting with BLOCK produced
  // "BLOCK BLOCK count=46".
  test("the block log line is not doubly prefixed", () => {
    const log = join(tmpRoot, sanitizePath(appDir), SESSION_ID, "hooks.log");
    seedAgo(
      "agent-logfmt",
      Array.from({ length: 31 }, () => 0.1),
    );
    runHook("agent-logfmt", WORK);
    expect(readFileSync(log, "utf8")).not.toContain("BLOCK BLOCK");
  });
});

// The acceptance check: the audited orchestrator's own Bash timeline.
describe("the audited orchestrator timeline", () => {
  test("produces zero blocks", () => {
    const agent = "agent-timeline";
    let blocks = 0;
    // 46 calls over 1h49: about one every 2.4 minutes, two thirds of them progress-log
    // appends the persona requires.
    const timeline = Array.from({ length: 46 }, (_, i) => ({
      minutesAgo: 109 - i * 2.4,
      command:
        i % 3 === 0
          ? "node scripts/pending-deploys.mjs --app /repo"
          : `echo "[wave] step ${i}" >> /tmp/s/harness-progress.log`,
    }));
    // Replay by seeding the window with the counted calls that precede each one.
    const countedSoFar = [];
    for (const step of timeline) {
      seedAgo(
        agent,
        countedSoFar.map((m) => m - step.minutesAgo + 0.01),
      );
      if (isBlocked(runHook(agent, step.command))) blocks++;
      if (!step.command.includes("harness-progress.log"))
        countedSoFar.push(step.minutesAgo);
    }
    expect(blocks).toBe(0);
  });
});
