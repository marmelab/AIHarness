// Unit tests for the session-cost arithmetic.
//
// The placeholder test is why this file exists: that bug was invisible to the CLI tests,
// which only asserted that a number was printed.

import { describe, expect, test } from "vitest";
import {
  CACHE_WRITE_1H_MULTIPLIER,
  RATES,
  classifyReviewDispatch,
  detectCacheExpiries,
  normalizeModel,
  price,
  rateFor,
  sumTallies,
  tallyTranscript,
} from "../lib/session-cost.mjs";

/** One transcript entry as the runtime writes it. */
const entry = ({ id, content, usage, ts, model = "claude-sonnet-5" }) =>
  JSON.stringify({
    type: "assistant",
    timestamp: ts || "2026-09-07T10:00:00.000Z",
    message: { id, role: "assistant", model, content, usage },
  });

const text = (t = "narrating") => [{ type: "text", text: t }];
const tool = (n = 1) =>
  Array.from({ length: n }, () => ({
    type: "tool_use",
    name: "Read",
    input: {},
  }));

const inputSide = {
  input_tokens: 2,
  cache_read_input_tokens: 30000,
  cache_creation_input_tokens: 700,
  cache_creation: {
    ephemeral_5m_input_tokens: 700,
    ephemeral_1h_input_tokens: 0,
  },
};

/**
 * One response as the runtime really writes it: N entries repeating the same input-side
 * usage, `output_tokens` a streaming placeholder on all but the last, and the last one
 * carrying the server's final accounting under `iterations`.
 */
const streamedResponse = ({ id = "msg_1", blocks, finalOutput, ts }) =>
  blocks.map((b, i) => {
    const last = i === blocks.length - 1;
    return entry({
      id,
      ts,
      content: [b],
      usage: last
        ? {
            ...inputSide,
            output_tokens: finalOutput,
            iterations: [
              { ...inputSide, output_tokens: finalOutput, type: "message" },
            ],
          }
        : { ...inputSide, output_tokens: 2 },
    });
  });

describe("tallyTranscript", () => {
  test("takes the server's final output count, not the streaming placeholder", () => {
    // Keeping the FIRST entry's usage reported 32K output where the truth was 280K.
    const body = streamedResponse({
      blocks: [{ type: "thinking", thinking: "which file" }, ...tool(2)],
      finalOutput: 232,
    }).join("\n");
    const t = tallyTranscript(body);
    expect(t.turns).toBe(1);
    expect(t.out).toBe(232);
  });

  test("falls back to the largest output_tokens when no iterations block exists", () => {
    // Older transcripts have no `iterations`; the last entry still holds the real count.
    const body = [
      entry({
        id: "m",
        content: text(),
        usage: { ...inputSide, output_tokens: 4 },
      }),
      entry({
        id: "m",
        content: tool(),
        usage: { ...inputSide, output_tokens: 511 },
      }),
    ].join("\n");
    expect(tallyTranscript(body).out).toBe(511);
  });

  test("counts one response as one turn however many entries it spans", () => {
    const body = streamedResponse({
      blocks: [{ type: "thinking", thinking: "hm" }, ...tool(2)],
      finalOutput: 100,
    }).join("\n");
    const t = tallyTranscript(body);
    expect(t.turns).toBe(1);
    expect(t.entries).toBe(3);
    expect(t.cacheRead).toBe(30000);
    expect(t.toolCalls).toBe(2);
  });

  test("counts fresh input, which no earlier version reported at all", () => {
    const body = [
      entry({
        id: "m",
        content: tool(),
        usage: { ...inputSide, input_tokens: 1234, output_tokens: 10 },
      }),
    ].join("\n");
    expect(tallyTranscript(body).in).toBe(1234);
  });

  test("splits cache write by TTL, since the two bill differently", () => {
    const body = entry({
      id: "m",
      content: tool(),
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 1500,
        cache_creation: {
          ephemeral_5m_input_tokens: 500,
          ephemeral_1h_input_tokens: 1000,
        },
        output_tokens: 10,
      },
    });
    const t = tallyTranscript(body);
    expect(t.cw5m).toBe(500);
    expect(t.cw1h).toBe(1000);
  });

  test("treats a bare cache_creation_input_tokens as a 5-minute write", () => {
    const body = entry({
      id: "m",
      content: tool(),
      usage: {
        input_tokens: 0,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 800,
        output_tokens: 10,
      },
    });
    const t = tallyTranscript(body);
    expect(t.cw5m).toBe(800);
    expect(t.cw1h).toBe(0);
  });

  test("reports responses whose entries disagree on input-side usage", () => {
    const body = [
      entry({
        id: "m",
        content: text(),
        usage: { ...inputSide, output_tokens: 2 },
      }),
      entry({
        id: "m",
        content: tool(),
        usage: {
          ...inputSide,
          cache_read_input_tokens: 999,
          output_tokens: 50,
        },
      }),
    ].join("\n");
    expect(tallyTranscript(body).usageMismatches).toBe(1);
  });

  test("ignores assistant messages the runtime never billed", () => {
    const body = [
      JSON.stringify({ type: "assistant", message: { content: [] } }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "go" },
      }),
      entry({
        id: "m",
        content: tool(),
        usage: { ...inputSide, output_tokens: 9 },
      }),
    ].join("\n");
    expect(tallyTranscript(body).turns).toBe(1);
  });

  test("survives a malformed line", () => {
    const body = [
      "{not json",
      entry({
        id: "m",
        content: tool(),
        usage: { ...inputSide, output_tokens: 9 },
      }),
    ].join("\n");
    expect(tallyTranscript(body).turns).toBe(1);
  });

  test("returns a zero tally for an empty transcript", () => {
    const t = tallyTranscript("");
    expect(t.turns).toBe(0);
    expect(t.out).toBe(0);
    expect(t.expiries.count).toBe(0);
  });
});

describe("detectCacheExpiries", () => {
  const turn = (minutes, cw, cr) => ({
    ts: Date.parse("2026-09-07T10:00:00.000Z") + minutes * 60000,
    in: 0,
    cw,
    cr,
  });

  test("flags a turn that re-wrote most of its context after a gap over 5 minutes", () => {
    const found = detectCacheExpiries([
      turn(0, 5000, 50000),
      turn(9, 48000, 7000),
    ]);
    expect(found.count).toBe(1);
    expect(found.tokens).toBe(48000);
    expect(found.at).toEqual([1]);
  });

  test("does not flag a large write that follows a short gap", () => {
    // Context growth, not a TTL lapse.
    expect(
      detectCacheExpiries([turn(0, 5000, 50000), turn(1, 48000, 7000)]).count,
    ).toBe(0);
  });

  test("does not flag a long gap whose next turn mostly read cache", () => {
    // Nothing was rewritten.
    expect(
      detectCacheExpiries([turn(0, 5000, 50000), turn(30, 900, 60000)]).count,
    ).toBe(0);
  });

  test("ignores a small context, where a full rewrite is what an opening turn looks like", () => {
    expect(
      detectCacheExpiries([turn(0, 100, 200), turn(30, 9000, 500)]).count,
    ).toBe(0);
  });

  test("never flags the first turn, which has no preceding gap", () => {
    expect(detectCacheExpiries([turn(0, 90000, 1000)]).count).toBe(0);
  });

  test("treats exactly five minutes as within the TTL", () => {
    expect(
      detectCacheExpiries([turn(0, 5000, 50000), turn(5, 48000, 7000)]).count,
    ).toBe(0);
  });
});

describe("rateFor and price", () => {
  test("normalizes a dated model id to its rate key", () => {
    expect(normalizeModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });

  test("prices the three models the harness dispatches", () => {
    expect(rateFor("claude-sonnet-5")).toMatchObject({
      input: 2,
      output: 10,
      known: true,
    });
    expect(rateFor("claude-opus-5")).toMatchObject({
      input: 5,
      output: 25,
      known: true,
    });
    expect(rateFor("claude-haiku-4-5-20251001")).toMatchObject({
      input: 1,
      output: 5,
      known: true,
    });
  });

  test("marks an unknown model rather than pricing it at zero", () => {
    const r = rateFor("claude-something-7");
    expect(r.known).toBe(false);
    expect(r.input).toBe(RATES["sonnet-5"][0]);
  });

  test("bills cache read at a tenth of input and a 5-minute write at 1.25x", () => {
    const p = price({
      in: 1e6,
      cacheRead: 1e6,
      cw5m: 1e6,
      cw1h: 0,
      out: 1e6,
      model: "claude-sonnet-5",
    });
    expect(p.input).toBeCloseTo(2, 6);
    expect(p.cacheRead).toBeCloseTo(0.2, 6);
    expect(p.cacheWrite).toBeCloseTo(2.5, 6);
    expect(p.output).toBeCloseTo(10, 6);
    expect(p.total).toBeCloseTo(14.7, 6);
  });

  test("bills a one-hour write at twice input, the reason the TTL is a tradeoff", () => {
    const p = price({
      in: 0,
      cacheRead: 0,
      cw5m: 0,
      cw1h: 1e6,
      out: 0,
      model: "claude-sonnet-5",
    });
    expect(p.cacheWrite).toBeCloseTo(2 * CACHE_WRITE_1H_MULTIPLIER, 6);
  });

  test("prices an opus reviewer above a sonnet one on identical usage", () => {
    const usage = { in: 0, cacheRead: 2e6, cw5m: 1e5, cw1h: 0, out: 2e4 };
    const opus = price({ ...usage, model: "claude-opus-5" }).total;
    const sonnet = price({ ...usage, model: "claude-sonnet-5" }).total;
    expect(opus / sonnet).toBeCloseTo(2.5, 6);
  });
});

describe("classifyReviewDispatch", () => {
  test.each([
    ["Review TASK-001", "ticket review"],
    ["Re-review TASK-001", "ticket re-review"],
    ["Re-review TASK-004 fix", "ticket re-review"],
    ["Re-review TASK-001 (final)", "ticket re-review"],
    ["Feature-review contact importance", "feature review"],
    ["Feature-review: contact importance", "feature review"],
    ["Feature-review fix round: importance null-clear", "feature re-review"],
    ["Re-review contact importance feature", "feature re-review"],
    ["Re-review feature-review fix", "feature re-review"],
    ["Feature-smoke: contact importance", "feature smoke"],
    ["Review TASK-005 (verdict-flag retry)", "verdict-flag retry"],
    ["Re-review TASK-001 fix (verdict-flag retry)", "verdict-flag retry"],
    ["", "other"],
    ["Check the migration", "other"],
  ])("classifies %j as %j", (desc, kind) => {
    expect(classifyReviewDispatch(desc)).toBe(kind);
  });

  test("ranks a verdict-flag retry above the re-review it also matches", () => {
    // A retry caused by a harness bug must not hide inside the re-review bucket.
    expect(
      classifyReviewDispatch("Re-review TASK-004 fix (verdict-flag retry)"),
    ).toBe("verdict-flag retry");
  });
});

describe("sumTallies", () => {
  test("adds tokens, dollars and expiries across agents", () => {
    const a = {
      turns: 2,
      entries: 4,
      toolTurns: 2,
      toolCalls: 3,
      in: 10,
      out: 100,
      cacheRead: 1e6,
      cw5m: 1000,
      cw1h: 0,
      model: "claude-sonnet-5",
      expiries: { count: 1, tokens: 900 },
    };
    const b = { ...a, expiries: { count: 2, tokens: 100 } };
    const s = sumTallies([a, b]);
    expect(s.turns).toBe(4);
    expect(s.cacheRead).toBe(2e6);
    expect(s.expiries).toBe(3);
    expect(s.expiredTokens).toBe(1000);
    expect(s.usd).toBeCloseTo(2 * price(a).total, 6);
  });

  test("returns zeroes for no agents", () => {
    expect(sumTallies([])).toMatchObject({ turns: 0, usd: 0, expiries: 0 });
  });
});
