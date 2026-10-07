// Tests for the Lot 0 comparison.
//
// Each figure here was wrong at least once when it was computed by hand, so each is
// pinned against a transcript whose answer can be worked out on paper: where the money
// went, which waiting counts, and what a tool result costs after it lands.
//
// The fixture goes through `buildRun` rather than being a hand-written row, so the
// comparison is tested against the derivation it will actually read, not against a shape
// invented here that the store would never hold.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeClassifier } from "../lib/activity.mjs";
import {
  armStats,
  compare,
  HUMAN_ABSENCE_MS,
  perSession,
} from "../lib/run-compare.mjs";
import { buildRun } from "../lib/run-model.mjs";
import { openStore, writeRun } from "../lib/run-store.mjs";

const classify = makeClassifier();
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

const store = () => {
  TMP = mkdtempSync(join(tmpdir(), "run-compare-"));
  return openStore(join(TMP, "runs.sqlite"));
};

const assistant = (id, ms, usage, content) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ms),
    message: { id, model: "claude-sonnet-5", usage, content },
  });

const result = (ms, toolUseId, text) =>
  JSON.stringify({
    type: "user",
    timestamp: at(ms),
    message: {
      content: [{ type: "tool_result", tool_use_id: toolUseId, content: text }],
    },
  });

/**
 * Two turns, so there is a preamble to tell apart from what the run accumulated.
 *
 *   turn 1  reads 1000, writes 0,    out  10   -> ctx 1000, which is the preamble
 *   turn 2  reads 3000, writes 1000, out 100   -> 1000 of that read is the preamble
 *
 * Sonnet is $2/Mtok in and $10/Mtok out, cache read 0.1x, cache write 1.25x.
 *
 * @param {number} [gapMs] silence before the second turn, for the stall cases
 */
const body = (gapMs = 1000) =>
  [
    assistant(
      "m1",
      0,
      {
        input_tokens: 0,
        output_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      },
      [
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "/a.ts" },
        },
      ],
    ),
    // 4000 bytes of result is 1000 tokens, landing with one more turn still to run.
    result(10, "t1", "x".repeat(4000)),
    assistant(
      "m2",
      gapMs,
      {
        input_tokens: 0,
        output_tokens: 100,
        cache_read_input_tokens: 3000,
        cache_creation_input_tokens: 1000,
      },
      [{ type: "text", text: "done" }],
    ),
  ].join("\n");

const tagged = (arm, { sessionId = "s1", gapMs = 1000 } = {}) =>
  buildRun({
    sessionId,
    slug: "-p",
    mainBody: body(gapMs),
    agents: [
      {
        agentId: "agent-1",
        body: body(gapMs),
        meta: { agentType: "aiharness:developer" },
      },
    ],
    hooksLog: "",
    classify,
    tags: { arm, label: arm },
  });

describe("armStats", () => {
  test("splits the bill into what the money bought", () => {
    const db = store();
    writeRun(db, tagged("A"));
    const s = armStats(db, "A");
    // Two agents run the same body, so every figure below is doubled.
    // preamble    (1000 + 1000) x 0.1 x $2/Mtok = $0.0004, twice
    // accumulated (   0 + 2000) x 0.1 x $2      = $0.0004, twice
    // cache write          1000 x 1.25 x $2     = $0.0025, twice
    // output          (10 + 100)      x $10     = $0.0011, twice
    expect(s.usdPreamble).toBeCloseTo(0.0008, 6);
    expect(s.usdAccumulated).toBeCloseTo(0.0008, 6);
    expect(s.usdCacheWrite).toBeCloseTo(0.005, 6);
    expect(s.usdOutput).toBeCloseTo(0.0022, 6);
    expect(s.usd).toBeCloseTo(0.0088, 6);
  });

  test("the preamble share is measured against what was re-read", () => {
    // 2000 of the 4000 actually re-read, not 2000 of the context's final size.
    const db = store();
    writeRun(db, tagged("A"));
    expect(armStats(db, "A").preambleShare).toBeCloseTo(0.5, 6);
  });

  test("a tool result is priced for every turn that re-reads it", () => {
    // The call is made in turn 0 of a 2-turn agent, so turn 1 re-reads it and the turn
    // that made it does not: 1000 x 1 x 0.1 x $2/Mtok, for each of the two agents.
    const db = store();
    writeRun(db, tagged("A"));
    expect(armStats(db, "A").usdAmplified).toBeCloseTo(0.0004, 6);
  });

  test("an overnight gap is not counted as dead time", () => {
    // Waiting for a person is not a result, and a 12-hour gap would otherwise swamp
    // every figure it appears next to.
    const db = store();
    writeRun(db, tagged("A", { gapMs: 12 * HUMAN_ABSENCE_MS }));
    const s = armStats(db, "A");
    expect(s.deadCount).toBe(0);
    expect(s.deadMs).toBe(0);
  });

  test("a gap the harness is answerable for is counted", () => {
    const db = store();
    writeRun(db, tagged("A", { gapMs: 10 * 60 * 1000 }));
    expect(armStats(db, "A").deadMs).toBeGreaterThan(0);
  });

  test("an arm with no runs reports none rather than zeroes", () => {
    const db = store();
    writeRun(db, tagged("A"));
    expect(armStats(db, "B").sessions).toBe(0);
  });

  test("one arm's runs do not leak into the other", () => {
    const db = store();
    writeRun(db, tagged("A"));
    writeRun(db, tagged("B", { sessionId: "s2" }));
    const a = armStats(db, "A");
    expect(a.sessions).toBe(1);
    expect(a.agents).toBe(2);
    expect(armStats(db, "B").sessions).toBe(1);
  });
});

describe("perSession", () => {
  test("divides the totals but not the count", () => {
    const per = perSession({ sessions: 4, agents: 8, usd: 20, turns: 100 });
    expect(per.sessions).toBe(4);
    expect(per.agents).toBe(2);
    expect(per.usd).toBe(5);
  });
});

describe("compare", () => {
  test("marks the better arm only where the measure has a direction", () => {
    const rows = Object.fromEntries(
      compare({ usd: 10, usdOutput: 10 }, { usd: 5, usdOutput: 20 }).map(
        (r) => [r.key, r],
      ),
    );
    expect(rows.usd.better).toBe("b");
    // More output is more work done, not a worse run, so it carries no verdict.
    expect(rows.usdOutput.better).toBe(null);
  });

  test("a gap inside the noise floor picks no winner", () => {
    const rows = Object.fromEntries(
      compare({ usd: 100 }, { usd: 101 }).map((r) => [r.key, r]),
    );
    expect(rows.usd.better).toBe(null);
  });

  test("a measure that is zero on A has no delta rather than an infinite one", () => {
    const rows = Object.fromEntries(
      compare({ usd: 0 }, { usd: 5 }).map((r) => [r.key, r]),
    );
    expect(rows.usd.delta).toBe(null);
  });
});
