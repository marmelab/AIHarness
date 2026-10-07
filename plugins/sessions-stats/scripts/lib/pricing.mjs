// What a Claude token costs: the rate table, and the arithmetic every cost figure is
// built from.
//
// cache_creation is not one price: 1.25x input at 5 minutes, 2x at an hour, and the split
// only appears under `usage.cache_creation`.
//
// Prices are per million tokens, Anthropic first-party API. Cache read is 0.1x input.

export const CACHE_READ_MULTIPLIER = 0.1;
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;

// [input, output] USD per million tokens.
export const RATES = {
  "sonnet-5": [2, 10],
  "opus-5": [5, 25],
  "haiku-4-5": [1, 5],
  // The critical review tier. Both ids carry the same price, and an unpriced one would
  // fall back to the sonnet-5 rate: a fifth of the truth, on the most expensive dispatch
  // the harness makes.
  "fable-5": [10, 50],
  "fable-5-1": [10, 50],
};

export const FALLBACK_RATE_MODEL = "sonnet-5";

/** Strip the vendor prefix and the dated suffix: claude-haiku-4-5-20251001 -> haiku-4-5. */
export function normalizeModel(model) {
  return String(model ?? "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

/**
 * Rate for a model. An unknown one is priced at the fallback rather than at zero, since a
 * silent zero reads as "this agent was free"; `known: false` is what the CLI warns on.
 * @param {string} model
 * @returns {{input: number, output: number, known: boolean, name: string}}
 */
export function rateFor(model) {
  const name = normalizeModel(model);
  const hit = RATES[name];
  const [input, output] = hit || RATES[FALLBACK_RATE_MODEL];
  return { input, output, known: Boolean(hit), name };
}

/**
 * Price one tally. Cache reads and writes are input-rate derivatives.
 * @param {{in: number, cacheRead: number, cw5m: number, cw1h: number, out: number, model: string}} t
 */
export function price(t) {
  const r = rateFor(t.model);
  const input = ((t.in || 0) * r.input) / 1e6;
  const cacheRead =
    ((t.cacheRead || 0) * CACHE_READ_MULTIPLIER * r.input) / 1e6;
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
    rateKnown: r.known,
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
