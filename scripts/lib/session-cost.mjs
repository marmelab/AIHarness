// Accounting for one session's transcripts: turns, tokens, dollars, cache expiries.
//
// Split out of session-cost.mjs so the arithmetic is unit-testable. The CLI parses argv
// and exits at import time; every rule that was ever wrong here is a pure function below.
//
// Three accounting traps, each measured on session a68592d0 (21 agents, 556 responses):
//
//  1. A TURN IS ONE API RESPONSE, NOT ONE TRANSCRIPT ENTRY. The transcript writes one
//     entry per content block, each repeating the SAME input-side usage. Summing per entry
//     inflated that run's turns 1.85x and its cache reads 76%.
//  2. output_tokens IS A STREAMING PLACEHOLDER ON EVERY ENTRY BUT THE LAST. The early
//     entries of a response carry 2 to 4; only the entry that also carries
//     `usage.iterations` holds the server's final count. Keeping the FIRST entry's usage
//     reported 32K output for a run whose real output was 280K, a 8.75x undercount.
//     Prefer the sum of `iterations[]` (the server's own accounting, and correct even if a
//     response ever chains several inference passes), fall back to the max.
//  3. cache_creation_input_tokens IS NOT ONE PRICE. A 5-minute write bills 1.25x input, a
//     1-hour write 2x, and the split only appears under `usage.cache_creation`.
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
};

export const FALLBACK_RATE_MODEL = "sonnet-5";

/** Strip the vendor prefix and the dated suffix: claude-haiku-4-5-20251001 -> haiku-4-5. */
export function normalizeModel(model) {
  return String(model ?? "")
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "");
}

/**
 * Rate for a model, and whether it was actually in the table.
 *
 * An unknown model is priced at the fallback rate rather than at zero, because a silent
 * zero reads as "this agent was free". `known: false` is what the CLI reports, so a
 * dollar figure is never quoted as exact when a model was guessed.
 *
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
 * Price one tally. Cache reads and writes are input-rate derivatives, output its own rate.
 *
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

// A cache entry written with the 5-minute TTL is gone after 5 minutes of silence; the next
// turn then re-writes the whole context instead of reading it. Both conditions are needed:
// a large write alone is just a growing context, and a long gap alone may follow a turn
// that wrote nothing.
export const EXPIRY_GAP_MS = 5 * 60 * 1000;
export const EXPIRY_WRITE_SHARE = 0.5;
// Below this the "share of context" test is noise: the opening turns of an agent are
// almost all cache write by construction.
export const EXPIRY_MIN_CONTEXT = 20000;

/**
 * Turns whose cache write looks like a re-write after a TTL lapse.
 *
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

// The orchestrator names each reviewer dispatch in free text, so this classifier reads a
// human label, not a field. Order matters: a verdict-flag retry is also a "Re-review".
// A dispatch that matches nothing lands in "other" rather than being forced into a bucket.
const REVIEW_KINDS = [
  [/verdict-flag/i, "verdict-flag retry"],
  [/^feature-smoke/i, "feature smoke"],
  [/^feature-review fix|^re-review .*feature/i, "feature re-review"],
  [/^feature-review/i, "feature review"],
  [/^re-review/i, "ticket re-review"],
  [/^review task/i, "ticket review"],
];

/**
 * Bucket one reviewer dispatch description.
 * @param {string} description
 */
export function classifyReviewDispatch(description) {
  const d = String(description ?? "").trim();
  for (const [re, kind] of REVIEW_KINDS) if (re.test(d)) return kind;
  return "other";
}

/** Output tokens the server finally billed for one response. */
function outputOf(rec) {
  if (rec.iterations)
    return rec.iterations.reduce((s, it) => s + (it.output_tokens || 0), 0);
  return rec.outMax;
}

/**
 * Tally one transcript body.
 *
 * @param {string} body raw JSONL
 */
export function tallyTranscript(body) {
  const byId = new Map();
  let anon = 0;
  let entries = 0;
  let usageMismatches = 0;

  for (const line of String(body ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = event.type === "assistant" && event.message?.usage;
    if (!usage) continue;
    entries++;
    const id = event.message.id || `anon-${anon++}`;
    const ts = Date.parse(event.timestamp);
    let rec = byId.get(id);
    if (!rec) {
      rec = {
        in: usage.input_tokens || 0,
        cr: usage.cache_read_input_tokens || 0,
        cw: usage.cache_creation_input_tokens || 0,
        cw5m:
          usage.cache_creation?.ephemeral_5m_input_tokens ??
          usage.cache_creation_input_tokens ??
          0,
        cw1h: usage.cache_creation?.ephemeral_1h_input_tokens || 0,
        outMax: 0,
        iterations: null,
        calls: 0,
        model: event.message.model || "",
        ts: Number.isFinite(ts) ? ts : NaN,
      };
      byId.set(id, rec);
    } else if (
      rec.in !== (usage.input_tokens || 0) ||
      rec.cr !== (usage.cache_read_input_tokens || 0) ||
      rec.cw !== (usage.cache_creation_input_tokens || 0)
    ) {
      // The input side is supposed to be identical across a response's entries. A count
      // here means that assumption broke and the totals are suspect.
      usageMismatches++;
    }
    rec.outMax = Math.max(rec.outMax, usage.output_tokens || 0);
    if (usage.iterations) rec.iterations = usage.iterations;
    if (!rec.model && event.message.model) rec.model = event.message.model;
    if (Number.isFinite(ts) && (!Number.isFinite(rec.ts) || ts < rec.ts))
      rec.ts = ts;
    rec.calls += (event.message.content || []).filter(
      (c) => c.type === "tool_use",
    ).length;
  }

  const t = {
    turns: 0,
    entries,
    usageMismatches,
    toolTurns: 0,
    toolCalls: 0,
    in: 0,
    out: 0,
    cacheRead: 0,
    cw5m: 0,
    cw1h: 0,
    model: "",
    models: [],
    ctxFirst: 0,
    ctxLast: 0,
    firstTs: NaN,
    lastTs: NaN,
    expiries: { count: 0, tokens: 0, at: [] },
  };
  const models = new Set();
  for (const rec of byId.values()) {
    t.turns++;
    t.in += rec.in;
    t.out += outputOf(rec);
    t.cacheRead += rec.cr;
    t.cw5m += rec.cw5m;
    t.cw1h += rec.cw1h;
    const ctx = rec.in + rec.cw + rec.cr;
    if (!t.ctxFirst) t.ctxFirst = ctx;
    t.ctxLast = ctx;
    if (rec.model) models.add(normalizeModel(rec.model));
    if (rec.calls) {
      t.toolTurns++;
      t.toolCalls += rec.calls;
    }
  }
  t.models = [...models];
  t.model = t.models[0] || "";

  const ordered = [...byId.values()]
    .filter((r) => Number.isFinite(r.ts))
    .sort((a, b) => a.ts - b.ts);
  if (ordered.length) {
    t.firstTs = ordered[0].ts;
    t.lastTs = ordered[ordered.length - 1].ts;
    t.expiries = detectCacheExpiries(ordered);
  }
  return t;
}

export const EMPTY_TALLY_KEYS = [
  "turns",
  "entries",
  "toolTurns",
  "toolCalls",
  "in",
  "out",
  "cacheRead",
  "cw5m",
  "cw1h",
];

/** Sum a list of tallies over the additive keys. */
export function sumTallies(rows) {
  const acc = Object.fromEntries(EMPTY_TALLY_KEYS.map((k) => [k, 0]));
  acc.expiries = 0;
  acc.expiredTokens = 0;
  acc.usd = 0;
  acc.usdInput = 0;
  acc.usdCacheRead = 0;
  acc.usdCacheWrite = 0;
  acc.usdOutput = 0;
  for (const r of rows) {
    for (const k of EMPTY_TALLY_KEYS) acc[k] += r[k] || 0;
    acc.expiries += r.expiries?.count || 0;
    acc.expiredTokens += r.expiries?.tokens || 0;
    const p = r.usd || price(r);
    acc.usd += p.total;
    acc.usdInput += p.input;
    acc.usdCacheRead += p.cacheRead;
    acc.usdCacheWrite += p.cacheWrite;
    acc.usdOutput += p.output;
  }
  return acc;
}
