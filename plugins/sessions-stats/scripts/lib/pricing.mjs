// What a Claude token costs: the rate table, and the arithmetic every cost figure is
// built from.
//
// cache_creation is not one price: 1.25x input at 5 minutes, 2x at an hour, and the split
// only appears under `usage.cache_creation`. Cache read is not one multiplier either: 0.1x
// input on most models, less on some, and on a long session it is most of the bill.
//
// Prices are per million tokens, Anthropic first-party API, from
// https://platform.claude.com/docs/en/about-claude/pricing. A model missing here is billed
// at the fallback rate and reported as unpriced, so a new model needs its row the day it
// is used, in this file and in its copy in the other plugin.

/** The cache read multiplier of a model whose row does not name its own. */
export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

// [input, output, cache read multiplier when not 0.1] USD per million tokens.
export const RATES = {
  // The critical review tier. Unpriced, it would fall back to the sonnet-5 rate: a fifth
  // of the truth, on the most expensive dispatch the harness makes.
  "fable-5-1": [10, 50, 0.025],
  "mythos-5-1": [10, 50, 0.025],
  "fable-5": [10, 50],
  "mythos-5": [10, 50],
  "opus-5-5": [4, 20, 0.05],
  "opus-5": [5, 25],
  "opus-4-8": [5, 25],
  "opus-4-7": [5, 25],
  "opus-4-6": [5, 25],
  "opus-4-5": [5, 25],
  "sonnet-5-5": [2, 10],
  "sonnet-5": [2, 10],
  "sonnet-4-6": [3, 15],
  "sonnet-4-5": [3, 15],
  "haiku-4-5": [1, 5],
};

export const FALLBACK_RATE_MODEL = "sonnet-5";

/**
 * Strip the vendor prefix, a context-window tag and the dated suffix:
 * claude-haiku-4-5-20251001 -> haiku-4-5, claude-opus-5-5[1m] -> opus-5-5.
 */
export function normalizeModel(model) {
  return String(model ?? "")
    .replace(/^claude-/, "")
    .replace(/\[[^\]]*\]$/, "")
    .replace(/-\d{8}$/, "");
}

/**
 * Rate for a model. An unknown one is priced at the fallback rather than at zero, since a
 * silent zero reads as "this agent was free"; `known: false` is what the reports warn on.
 * @param {string} model
 * @returns {{input: number, output: number, cacheRead: number, known: boolean, name: string}}
 */
export function rateFor(model) {
  const name = normalizeModel(model);
  const hit = RATES[name];
  const [input, output, cacheRead = CACHE_READ_MULTIPLIER] =
    hit || RATES[FALLBACK_RATE_MODEL];
  return { input, output, cacheRead, known: Boolean(hit), name };
}

/**
 * Price one tally. Cache reads and writes are input-rate derivatives.
 *
 * A tally that billed no token needs no rate, so it never marks the price unknown: the
 * runtime writes zero-usage turns under the model name `<synthetic>`.
 * @param {{in: number, cacheRead: number, cw5m: number, cw1h: number, out: number, model: string}} t
 */
export function price(t) {
  const r = rateFor(t.model);
  const input = ((t.in || 0) * r.input) / 1e6;
  const cacheRead = ((t.cacheRead || 0) * r.cacheRead * r.input) / 1e6;
  const cacheWrite =
    (((t.cw5m || 0) * CACHE_WRITE_5M_MULTIPLIER +
      (t.cw1h || 0) * CACHE_WRITE_1H_MULTIPLIER) *
      r.input) /
    1e6;
  const output = ((t.out || 0) * r.output) / 1e6;
  return {
    input,
    cacheRead,
    cacheWrite,
    output,
    total: input + cacheRead + cacheWrite + output,
    rateKnown: r.known || !(t.in || t.cacheRead || t.cw5m || t.cw1h || t.out),
  };
}

// A 5-minute cache entry dies after 5 minutes of silence and the next turn re-writes the
// whole context. BOTH conditions are needed: a large write alone is a growing context, a
// long gap alone may follow a turn that wrote nothing.
export const EXPIRY_GAP_MS = 5 * 60 * 1000;
export const EXPIRY_WRITE_SHARE = 0.5;
// Below this the share test is noise: an agent's opening turns are almost all write.
export const EXPIRY_MIN_CONTEXT = 20000;

/**
 * Turns whose cache write looks like a re-write after a TTL lapse.
 * @param {{ts: number, in: number, cw: number, cr: number}[]} turns sorted by ts
 * @returns {{count: number, tokens: number, at: number[]}}
 */
export function detectCacheExpiries(turns) {
  const at = [];
  let tokens = 0;
  for (let i = 1; i < turns.length; i++) {
    const t = turns[i];
    const ctx = (t.in || 0) + (t.cw || 0) + (t.cr || 0);
    const gap = t.ts - turns[i - 1].ts;
    if (!Number.isFinite(gap) || gap <= EXPIRY_GAP_MS) continue;
    if (ctx < EXPIRY_MIN_CONTEXT) continue;
    if ((t.cw || 0) <= EXPIRY_WRITE_SHARE * ctx) continue;
    at.push(i);
    tokens += t.cw || 0;
  }
  return { count: at.length, tokens, at };
}
