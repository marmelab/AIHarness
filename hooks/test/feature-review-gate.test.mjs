// The end-of-feature gate, end to end across the two hooks that make it up.
//
// The property: a reviewer that emits APPROVED gets the flag recorded AND the suite
// launched, having written nothing itself. No agent-side Bash call is part of the
// mechanism, so the gate cannot be lost to a dispatch prompt that forgot to ask for one.
//
// Both hooks are driven with the SAME payload, in registration order, which is what a
// SubagentStop event does. Neither is allowed to depend on the other's file write: they
// parse the same contract line with the same parser (lib/verdict.mjs), and the test proves
// it by running e2e-on-feature-review with no flag on disk at all.

import { spawnSync } from "node:child_process";
import {
  existsSync,
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
import { sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD = join(HERE, "..", "record-review-verdict.mjs");
const E2E = join(HERE, "..", "e2e-on-feature-review.mjs");
const SESSION_ID = "fr9a8b7c-1111-2222-3333-444455556666";

let TMP, APP_DIR, SESSION_DIR, layout, env;
let agentSeq = 0;

// Records the worktree it was handed (the hook passes it as E2E_SMOKE_SRC, not argv), so
// "did the suite launch" is a file on disk.
const SMOKE =
  '#!/usr/bin/env bash\necho "$E2E_SMOKE_SRC" > "${E2E_SMOKE_SRC}_ran"\nexit 0\n';

const flag = () => join(SESSION_DIR, "reviews", "FEATURE-quality-reviewer");
const ranMarker = () => join(SESSION_DIR, "_session_ran");

// One reviewer stop, exactly as the runtime sends it: empty agent_type, the MAIN session
// transcript, identity in agent_id, and the verdict only in the agent's own transcript.
// Then both SubagentStop hooks, in registration order.
const reviewerStop = (finalMessage, { mode = "feature-review" } = {}) => {
  const id = `a000000000000007${agentSeq++}`;
  spawnAgent(
    layout,
    id,
    { agentType: "aiharness:quality-reviewer", description: "Feature review" },
    `ROLE: quality-reviewer\nMODE: ${mode}\nTICKETS_DIR: ${SESSION_DIR}\n`,
    [finalMessage],
  );
  const payload = JSON.stringify(stopPayload(layout, id));
  const record = spawnSync("node", [RECORD], {
    input: payload,
    env,
    encoding: "utf8",
  });
  const e2e = spawnSync("node", [E2E], {
    input: payload,
    env,
    encoding: "utf8",
  });
  return { record, e2e };
};

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "feature-review-gate-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  SESSION_DIR = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(join(SESSION_DIR, "_session"), { recursive: true });

  const scripts = join(APP_DIR, ".claude", "scripts");
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, "e2e-smoke.sh"), SMOKE, { mode: 0o755 });

  layout = runtimeLayout(join(TMP, "transcripts"), SESSION_ID);
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
  delete env.CLAUDE_PROJECT_DIR;
  agentSeq = 0;
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("an APPROVED feature review", () => {
  test("records the FEATURE flag and launches the suite, with no agent write", () => {
    // Nothing on disk beforehand: no flag, so the suite cannot be gating on one the
    // reviewer wrote.
    expect(existsSync(flag())).toBe(false);

    const { record, e2e } = reviewerStop("All parts integrate.\nAPPROVED");
    expect(record.status).toBe(0);
    expect(e2e.status).toBe(0);

    expect(existsSync(flag())).toBe(true);
    expect(readFileSync(ranMarker(), "utf8").trim()).toBe(
      join(SESSION_DIR, "_session"),
    );
  });

  test("launches the suite even if the flag write failed entirely", () => {
    // The flag is bookkeeping for the merger gate. The suite reads the verdict, so a
    // record-review-verdict that never ran cannot silently cost a suite run.
    const id = "a00000000000000099";
    spawnAgent(
      layout,
      id,
      { agentType: "quality-reviewer", description: "Feature review" },
      "ROLE: quality-reviewer\nMODE: feature-review\n",
      ["APPROVED"],
    );
    const r = spawnSync("node", [E2E], {
      input: JSON.stringify(stopPayload(layout, id)),
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(existsSync(flag())).toBe(false);
    expect(existsSync(ranMarker())).toBe(true);
  });
});

describe("a refused feature review", () => {
  test.each(["BLOCKED", "REJECTED"])(
    "%s: does not launch the suite and leaves no flag",
    (word) => {
      const { e2e } = reviewerStop(
        `${word}:\n- src/deal.ts:12 - the importance filter is missing`,
      );
      expect(e2e.status).toBe(0);
      expect(existsSync(flag())).toBe(false);
      expect(existsSync(ranMarker())).toBe(false);
    },
  );

  test.each(["BLOCKED", "REJECTED"])(
    "%s: clears a flag left over from an earlier round",
    (word) => {
      reviewerStop("APPROVED");
      expect(existsSync(flag())).toBe(true);
      rmSync(ranMarker(), { force: true });

      reviewerStop(`${word}:\n- src/deal.ts:12 - regressed`);
      expect(existsSync(flag())).toBe(false);
      // And the stale flag did not buy a second suite run.
      expect(existsSync(ranMarker())).toBe(false);
    },
  );
});

describe("an unparseable verdict", () => {
  test("writes no flag and launches nothing", () => {
    const { e2e } = reviewerStop("I am still weighing the tradeoffs");
    expect(e2e.status).toBe(0);
    expect(existsSync(flag())).toBe(false);
    expect(existsSync(ranMarker())).toBe(false);
  });

  test("never turns an existing flag into an approval it did not parse", () => {
    reviewerStop("APPROVED");
    expect(existsSync(flag())).toBe(true);
    rmSync(ranMarker(), { force: true });
    // The flag survives (only a parsed negative clears it), and that is exactly the
    // fallback case: a runtime with no readable verdict still gates on the flag.
    const { e2e } = reviewerStop("Still checking one thing");
    expect(e2e.status).toBe(0);
    expect(existsSync(flag())).toBe(true);
    expect(existsSync(ranMarker())).toBe(true);
  });
});

describe("a per-ticket review is not a feature review", () => {
  test("APPROVED on a ticket keys its own flag and launches nothing", () => {
    const id = "a00000000000000088";
    spawnAgent(
      layout,
      id,
      { agentType: "quality-reviewer", description: "Review TASK-004" },
      "ROLE: quality-reviewer\nTASK_ID: TASK-004\n",
      ["APPROVED"],
    );
    const payload = JSON.stringify(stopPayload(layout, id));
    spawnSync("node", [RECORD], { input: payload, env, encoding: "utf8" });
    spawnSync("node", [E2E], { input: payload, env, encoding: "utf8" });

    expect(
      existsSync(join(SESSION_DIR, "reviews", "TASK-004-quality-reviewer")),
    ).toBe(true);
    expect(existsSync(flag())).toBe(false);
    expect(existsSync(ranMarker())).toBe(false);
  });
});
