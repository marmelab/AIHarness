// Accounting for one session's transcripts: turns, tokens, dollars, cache expiries.
//
// Split out of session-cost.mjs so the arithmetic is unit-testable. Three traps, each of
// which produced a figure someone then quoted:
//
//  1. A TURN IS ONE API RESPONSE, NOT ONE TRANSCRIPT ENTRY. The transcript writes one
//     entry per content block, each repeating the same input-side usage.
//  2. output_tokens IS A STREAMING PLACEHOLDER on every entry but the last. Only the
//     entry carrying `usage.iterations` holds the server's final count. Prefer the sum of
//     `iterations` (correct even if a response chains several passes), else the max.
//  3. cache_creation IS NOT ONE PRICE: 1.25x input at 5 minutes, 2x at an hour, and the
//     split only appears under `usage.cache_creation`.
//
// The rate table and the arithmetic on it live in pricing.mjs, which the run-anatomy plugin
// carries a verbatim copy of; they are re-exported here for this file's callers.

import { detectCacheExpiries, normalizeModel, price } from "./pricing.mjs";

export {
  CACHE_READ_MULTIPLIER,
  CACHE_WRITE_5M_MULTIPLIER,
  CACHE_WRITE_1H_MULTIPLIER,
  RATES,
  FALLBACK_RATE_MODEL,
  normalizeModel,
  rateFor,
  price,
  EXPIRY_GAP_MS,
  EXPIRY_WRITE_SHARE,
  EXPIRY_MIN_CONTEXT,
  detectCacheExpiries,
} from "./pricing.mjs";

// Reads a free-text label, not a field. ORDER MATTERS: a verdict-flag retry is also a
// "Re-review". No match lands in "other" rather than being forced into a bucket.
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
      // The input side must be identical across a response's entries; a count here means
      // that assumption broke and the totals are suspect.
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
