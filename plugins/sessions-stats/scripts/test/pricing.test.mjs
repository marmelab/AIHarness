// Tests for the rate table: every model the runtime writes into a transcript is priced at
// its own rate, cache reads included, and one that is not says so instead of passing for
// the fallback.

import { describe, expect, test } from "vitest";
import { normalizeModel, price, rateFor } from "../lib/pricing.mjs";

const MTOK = 1e6;

describe("rateFor", () => {
  // The model ids current transcripts carry, as written there.
  test.each([
    ["claude-fable-5-1", 10, 50],
    ["claude-fable-5", 10, 50],
    ["claude-opus-5-5", 4, 20],
    ["claude-opus-5-5[1m]", 4, 20],
    ["claude-opus-5", 5, 25],
    ["claude-opus-4-8", 5, 25],
    ["claude-sonnet-5-5", 2, 10],
    ["claude-sonnet-5", 2, 10],
    ["claude-sonnet-4-6", 3, 15],
    ["claude-haiku-4-5-20251001", 1, 5],
  ])("prices %s at its own rate", (model, input, output) => {
    expect(rateFor(model)).toMatchObject({ input, output, known: true });
  });

  test("a model with no row is flagged, not priced at zero", () => {
    expect(rateFor("claude-future-9")).toMatchObject({
      known: false,
      input: 2,
      name: "future-9",
    });
  });
});

describe("normalizeModel", () => {
  test("drops the vendor prefix, a context-window tag and a date", () => {
    expect(normalizeModel("claude-opus-5-5[1m]")).toBe("opus-5-5");
    expect(normalizeModel("claude-haiku-4-5-20251001")).toBe("haiku-4-5");
  });
});

describe("price", () => {
  // A cache read is most of a long session's bill, and its multiplier is the model's.
  test.each([
    ["claude-fable-5-1", 0.25],
    ["claude-opus-5-5", 0.2],
    ["claude-fable-5", 1],
    ["claude-opus-5", 0.5],
    ["claude-sonnet-5-5", 0.2],
  ])("a million cache reads on %s cost $%s", (model, usd) => {
    expect(price({ cacheRead: MTOK, model }).cacheRead).toBeCloseTo(usd, 6);
  });

  test("writes cost 1.25x input at five minutes and 2x at an hour, on every model", () => {
    const p = price({ cw5m: MTOK, cw1h: MTOK, model: "claude-opus-5-5" });
    expect(p.cacheWrite).toBeCloseTo(4 * 1.25 + 4 * 2, 6);
  });

  test("a turn that billed nothing needs no rate", () => {
    // The runtime writes zero-usage turns under the model name `<synthetic>`.
    expect(price({ model: "<synthetic>" }).rateKnown).toBe(true);
    expect(price({ out: 10, model: "<synthetic>" }).rateKnown).toBe(false);
  });
});
