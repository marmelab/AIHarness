// The arithmetic has to close.
//
// Every other test in this directory pins one rule. This one pins the relations BETWEEN
// them, which is where the errors that survive a review live: a figure can be individually
// defensible and still contradict the one beside it. Three did, and all three were found by
// running these assertions over the real archive rather than by reading the code:
//
//   - an agent's cost was priced at ONE of its models for all of its tokens, so a main
//     thread alternating opus and fable reported $204 where its turns add up to $125;
//   - coordination plus stalls did not equal the window minus the busy time, because the
//     gaps between spans leave the window's leading and trailing slivers uncounted;
//   - the active time exceeded the window it sits in, because a turn's span is extended
//     backwards by the wait it charges and the first one reached before the window began.
//
// The fixtures below are built to exercise each: two models in one agent, a gap past the
// stall threshold, and a first turn carrying a long wait.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeClassifier } from "../lib/activity.mjs";
import { buildRun, STALL_MS } from "../lib/run-model.mjs";
import { openStore, writeRun } from "../lib/run-store.mjs";

const classify = makeClassifier();
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

const turn = (ms, id, model, tool, input, over = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ms),
    message: {
      id,
      model,
      usage: {
        input_tokens: 0,
        output_tokens: 500,
        cache_read_input_tokens: 40000,
        cache_creation_input_tokens: 0,
        ...over,
      },
      content: tool
        ? [{ type: "tool_use", id: "u" + id, name: tool, input }]
        : [],
    },
  });
const result = (ms, id) =>
  JSON.stringify({
    type: "user",
    timestamp: at(ms),
    message: {
      content: [{ type: "tool_result", tool_use_id: "u" + id, content: "ok" }],
    },
  });

// A main thread on two models, with turns before, during and after the subagent window.
const mainBody = [
  turn(0, "m1", "claude-opus-5", "Read", { file_path: "/a.ts" }),
  result(1000, "m1"),
  turn(120000, "m2", "claude-fable-5-1", "Read", { file_path: "/b.ts" }),
  result(121000, "m2"),
  turn(240000, "m3", "claude-opus-5", "Bash", { command: "git status" }),
  result(241000, "m3"),
  turn(600000, "m4", "claude-fable-5-1", null),
].join("\n");

// A subagent whose first turn carries a long wait, and which stops for longer than the
// stall threshold before coming back.
const devBody = [
  turn(180000, "d1", "claude-sonnet-5", "Edit", {
    file_path: "/src/a.ts",
    old_string: "x",
  }),
  result(182000, "d1"),
  turn(182000 + STALL_MS * 2, "d2", "claude-sonnet-5", "Bash", {
    command: "npm test",
  }),
  result(182000 + STALL_MS * 2 + 5000, "d2"),
].join("\n");

const run = () =>
  buildRun({
    sessionId: "inv-1",
    slug: "-fixture",
    mainBody,
    agents: [
      {
        agentId: "dev-1",
        body: devBody,
        meta: { agentType: "aiharness:developer" },
      },
    ],
    classify,
  });

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});
const stored = () => {
  TMP = mkdtempSync(join(tmpdir(), "run-inv-"));
  const db = openStore(join(TMP, "runs.sqlite"));
  writeRun(db, run());
  return db;
};

// A second shape, built for the two defects the first one cannot reach: a window only
// seconds long, a host turn inside it whose preceding gap is longer than the whole window,
// and another host turn whose result lands well after the window closes. The first makes an
// unclamped active span exceed the window; the second leaves a sliver of the window outside
// every interior gap, which is what stopped coordination and stalls from closing.
const tightMain = [
  turn(400000, "t0", "claude-opus-5", "Read", { file_path: "/x.ts" }),
  result(401000, "t0"),
  // 600 s later, so the wait this turn carries dwarfs the 3-second window it sits in.
  turn(1001500, "t1", "claude-opus-5", "Read", { file_path: "/y.ts" }),
  result(1001800, "t1"),
  // Starts inside the window and finishes long after it: busy overhangs the window's end.
  turn(1002500, "t2", "claude-opus-5", "Bash", { command: "git log" }),
  result(1010000, "t2"),
].join("\n");

const tightDev = [
  turn(1000000, "g1", "claude-sonnet-5", "Edit", {
    file_path: "/s.ts",
    old_string: "x",
  }),
  result(1001000, "g1"),
  turn(1002000, "g2", "claude-sonnet-5", "Bash", { command: "npm test" }),
  result(1003000, "g2"),
].join("\n");

const tight = () =>
  buildRun({
    sessionId: "inv-2",
    slug: "-fixture",
    mainBody: tightMain,
    agents: [
      {
        agentId: "dev-2",
        body: tightDev,
        meta: { agentType: "aiharness:developer" },
      },
    ],
    classify,
  });

describe("a window shorter than the waits around it", () => {
  test("the fixture is really tight, so the next two are not vacuous", () => {
    const r = tight();
    expect(r.windowMs).toBeLessThan(60000);
    // A host turn inside the window carries a wait longer than the window itself.
    const main = r.agents.find((a) => a.agentId === "main");
    const inside = main.turnRows.filter(
      (t) => t.at >= r.windowStart && t.at <= r.windowEnd,
    );
    expect(inside.some((t) => t.waitMs > r.windowMs)).toBe(true);
    // And one of them finishes after the window closes.
    expect(inside.some((t) => t.endAt > r.windowEnd)).toBe(true);
  });

  test("active time cannot exceed the window it describes", () => {
    const r = tight();
    expect(r.activeMs).toBeLessThanOrEqual(r.windowMs);
  });

  test("coordination plus stalls still closes exactly", () => {
    const r = tight();
    expect(r.coordMs + r.stallMs).toBe(r.windowMs - r.busyMs);
    expect(r.busyMs).toBeLessThanOrEqual(r.windowMs);
  });
});

describe("cost", () => {
  test("an agent costs what its turns cost, each at its own model's rate", () => {
    for (const a of run().agents) {
      const fromTurns = a.turnRows.reduce((s, t) => s + (t.usd || 0), 0);
      expect(a.usd).toBeCloseTo(fromTurns, 6);
    }
  });

  test("a two-model agent is not priced at one of them", () => {
    // The regression that hid for the whole archive: the main thread here runs opus and
    // fable, whose rates differ several-fold, so a single-rate total cannot coincide.
    const main = run().agents.find((a) => a.agentId === "main");
    expect(new Set(main.models).size).toBeGreaterThan(1);
    const perTurn = main.turnRows.reduce((s, t) => s + t.usd, 0);
    expect(main.usd).toBeCloseTo(perTurn, 6);
  });

  test("the run costs what its in-window turns cost", () => {
    const r = run();
    expect(r.usd).toBeCloseTo(
      r.agents.reduce((s, a) => s + a.usdInWindow, 0),
      6,
    );
    expect(r.hostUsd).toBeCloseTo(
      r.agents.reduce((s, a) => s + a.outsideUsd, 0),
      6,
    );
    // And nothing is lost between the two.
    for (const a of r.agents)
      expect(a.usdInWindow + a.outsideUsd).toBeCloseTo(a.usd, 6);
  });
});

describe("the clocks close", () => {
  test("coordination plus stalls is exactly the window minus the busy time", () => {
    const r = run();
    expect(r.coordMs + r.stallMs).toBe(r.windowMs - r.busyMs);
  });

  test("busy and active both sit inside the window", () => {
    const r = run();
    expect(r.busyMs).toBeLessThanOrEqual(r.windowMs);
    expect(r.activeMs).toBeLessThanOrEqual(r.windowMs);
  });

  test("the fixture really does contain a stall, so the identity is not vacuous", () => {
    const r = run();
    expect(r.stalls.length).toBeGreaterThan(0);
    expect(r.stallMs).toBeGreaterThanOrEqual(STALL_MS);
  });
});

describe("the window accounts for every turn", () => {
  test("in-window and outside add up to the whole", () => {
    for (const a of run().agents) {
      expect(a.turnsInWindow + a.outsideTurns).toBe(a.turns);
      expect(a.turnsInWindow).toBeLessThanOrEqual(a.turns);
    }
  });

  test("the fixture really does have turns on both sides", () => {
    const main = run().agents.find((a) => a.agentId === "main");
    expect(main.turnsInWindow).toBeGreaterThan(0);
    expect(main.outsideTurns).toBeGreaterThan(0);
  });

  test("the run's turn count is the in-window sum", () => {
    const r = run();
    expect(r.turnCount).toBe(r.agents.reduce((s, a) => s + a.turnsInWindow, 0));
  });
});

describe("activities", () => {
  test("a merged wall-clock never exceeds the sum it merges", () => {
    for (const a of run().agents)
      for (const row of a.activityRows)
        expect(row.wallMs).toBeLessThanOrEqual(row.durationMs);
  });

  test("the activity rows account for every call", () => {
    for (const a of run().agents)
      expect(a.activityRows.reduce((s, r) => s + r.calls, 0)).toBe(a.calls);
  });

  test("a charged duration never exceeds the raw one", () => {
    for (const a of run().agents)
      for (const c of a.callRows)
        expect(c.chargedMs).toBeLessThanOrEqual(c.durationMs);
  });
});

describe("the store holds what the model computed", () => {
  test("every figure survives the round trip", () => {
    const db = stored();
    const r = run();
    const row = db
      .prepare(
        `SELECT usd, turn_count, busy_ms, coord_ms, stall_ms, window_ms, host_usd
         FROM runs WHERE session_id = 'inv-1'`,
      )
      .get();
    expect(row.turn_count).toBe(r.turnCount);
    expect(row.usd).toBeCloseTo(r.usd, 6);
    expect(row.coord_ms + row.stall_ms).toBe(row.window_ms - row.busy_ms);
    expect(
      db
        .prepare(`SELECT count(*) n FROM stalls WHERE session_id = 'inv-1'`)
        .get().n,
    ).toBe(r.stalls.length);
  });

  test("an agent's stored cost is its stored turns' cost", () => {
    const db = stored();
    for (const a of db
      .prepare(`SELECT agent_id, usd FROM agents WHERE session_id = 'inv-1'`)
      .all()) {
      const t = db
        .prepare(
          `SELECT sum(usd) s FROM turns WHERE session_id = 'inv-1' AND agent_id = ?`,
        )
        .get(a.agent_id);
      expect(a.usd).toBeCloseTo(t.s, 6);
    }
  });
});
