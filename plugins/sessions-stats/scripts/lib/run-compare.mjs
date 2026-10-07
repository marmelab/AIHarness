// Comparing two arms of a measured run.
//
// Lot 0 asks one question: does the harness pay for itself on the same task? Answering it
// needs the same figures on both sides, derived the same way, which is exactly what went
// wrong when they were computed by hand. Four of them had to be corrected after the fact:
//
//   - a run is not a session, so cost outside the subagent window is not the run's
//   - an agent's bill is the sum of its turns, each at its own model's rate, not its
//     totals at one rate
//   - a gap past the idle cap is idle whole, never part generation
//   - the preamble is a floor under every turn, so its share is ctx_first against what
//     the turn actually re-read, not against the context at the end
//
// Each measure below states what it counts, because a comparison is only as good as the
// agreement on what is being compared.

import { rateFor } from "./pricing.mjs";

/** Gaps longer than this are a person being elsewhere, not the harness making anyone wait. */
export const HUMAN_ABSENCE_MS = 60 * 60 * 1000;

/** 5-minute cache TTL: a write after a lapse this long re-paid for the whole context. */
export const CACHE_WRITE_MULTIPLIER = 1.25;

const sum = (rows, f) => rows.reduce((t, r) => t + (f(r) || 0), 0);

/**
 * Every figure for one arm, or for the whole store when `arm` is null.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {string|null} arm
 * @returns {object}
 */
export function armStats(db, arm) {
  const where = arm == null ? "" : " WHERE arm = ?";
  const p = arm == null ? [] : [arm];
  const q = (sql, ...extra) => db.prepare(sql).all(...extra);

  const runs = q(`SELECT * FROM runs${where}`, ...p);
  if (!runs.length) return { arm, sessions: 0 };
  const ids = runs.map((r) => r.session_id);
  const inList = `(${ids.map(() => "?").join(",")})`;

  const agents = q(
    `SELECT * FROM agents WHERE session_id IN ${inList}`,
    ...ids,
  );
  const turns = q(
    `SELECT t.*, a.ctx_first, a.role FROM turns t
       JOIN agents a ON a.session_id = t.session_id AND a.agent_id = t.agent_id
      WHERE t.session_id IN ${inList}`,
    ...ids,
  );
  const calls = q(
    `SELECT session_id, agent_id, turn_idx, result_len FROM calls
      WHERE session_id IN ${inList} AND result_len > 0`,
    ...ids,
  );
  const stalls = q(
    `SELECT ms FROM stalls WHERE session_id IN ${inList}`,
    ...ids,
  );
  const loops = q(
    `SELECT kind, wasted_ms FROM loops WHERE session_id IN ${inList}`,
    ...ids,
  );

  // Cost, split by what the money actually bought. The preamble is the floor every turn
  // re-reads; whatever a turn read above it is conversation the run accumulated.
  const cost = {
    preamble: 0,
    accumulated: 0,
    cacheWrite: 0,
    output: 0,
    input: 0,
  };
  for (const t of turns) {
    const r = rateFor(t.model);
    const read = t.cache_read || 0;
    const floor = Math.min(read, t.ctx_first || 0);
    // Each model reads its cache at its own fraction of input.
    cost.preamble += (floor * r.cacheRead * r.input) / 1e6;
    cost.accumulated += ((read - floor) * r.cacheRead * r.input) / 1e6;
    cost.cacheWrite +=
      ((t.cache_write || 0) * CACHE_WRITE_MULTIPLIER * r.input) / 1e6;
    cost.output += ((t.out_tokens || 0) * r.output) / 1e6;
    cost.input += ((t.in_tokens || 0) * r.input) / 1e6;
  }
  const total =
    cost.preamble +
    cost.accumulated +
    cost.cacheWrite +
    cost.output +
    cost.input;

  // What a tool result costs after it lands: it is re-read on every later turn of the
  // same agent, so a result's price is its size times the turns the agent has left.
  const life = new Map();
  for (const a of agents)
    life.set(a.session_id + "|" + a.agent_id, a.turns || 0);
  const model = new Map();
  for (const t of turns) {
    const k = t.session_id + "|" + t.agent_id;
    if (!model.has(k)) model.set(k, t.model);
  }
  let amplified = 0;
  for (const c of calls) {
    const k = c.session_id + "|" + c.agent_id;
    const r = rateFor(model.get(k));
    // The turn that MADE the call does not re-read its own result, so an agent of N turns
    // re-reads a result from turn i exactly N - 1 - i times. Counting the issuing turn
    // too overstates every result by one turn's worth.
    const left = Math.max(0, (life.get(k) || 0) - 1 - (c.turn_idx || 0));
    amplified += ((c.result_len / 4) * left * r.cacheRead * r.input) / 1e6;
  }

  const turnCount = turns.length || 1;
  const inSession = stalls.filter((s) => s.ms < HUMAN_ABSENCE_MS);
  const readPerTurn = sum(turns, (t) => t.cache_read) / turnCount;

  return {
    arm,
    sessions: runs.length,
    agents: agents.length,
    turns: turns.length,
    calls: sum(runs, (r) => r.call_count),

    windowMs: sum(runs, (r) => r.window_ms),
    busyMs: sum(runs, (r) => r.busy_ms),
    coordMs: sum(runs, (r) => r.coord_ms),
    // Only the waiting the harness is answerable for. An overnight gap is not a result.
    deadMs: sum(inSession, (s) => s.ms),
    deadCount: inSession.length,

    usd: total,
    usdPreamble: cost.preamble,
    usdAccumulated: cost.accumulated,
    usdCacheWrite: cost.cacheWrite,
    usdOutput: cost.output,
    usdAmplified: amplified,

    readPerTurn,
    preambleShare: readPerTurn
      ? sum(turns, (t) => Math.min(t.cache_read || 0, t.ctx_first || 0)) /
        sum(turns, (t) => t.cache_read || 1)
      : 0,

    redispatchMs: sum(
      loops.filter((l) => l.kind === "redispatch"),
      (l) => l.wasted_ms,
    ),
    expiries: sum(agents, (a) => a.expiries),
  };
}

/** The measures a comparison prints, in the order it prints them. */
export const MEASURES = [
  { key: "agents", label: "agents", fmt: "n" },
  { key: "turns", label: "turns", fmt: "n" },
  // No direction: the window runs from the first subagent to the last, so it contains
  // every gap in between, including the ones where nobody was at the keyboard. On the
  // archive it reads as 73 hours a session for the arm whose user went to bed, which is
  // not a result about the arm. `dead time` below is the part anyone is answerable for.
  { key: "windowMs", label: "wall clock", fmt: "h" },
  { key: "busyMs", label: "  of which tools", fmt: "h" },
  { key: "coordMs", label: "  of which coordination", fmt: "h", lower: true },
  { key: "deadMs", label: "  of which dead time", fmt: "h", lower: true },
  { key: "usd", label: "cost", fmt: "$", lower: true },
  { key: "usdPreamble", label: "  preamble re-read", fmt: "$", lower: true },
  {
    key: "usdAccumulated",
    label: "  accumulated re-read",
    fmt: "$",
    lower: true,
  },
  { key: "usdCacheWrite", label: "  cache write", fmt: "$", lower: true },
  { key: "usdOutput", label: "  output", fmt: "$" },
  {
    key: "usdAmplified",
    label: "tool results, re-read",
    fmt: "$",
    lower: true,
  },
  {
    key: "readPerTurn",
    label: "context read per turn",
    fmt: "tok",
    lower: true,
  },
  { key: "redispatchMs", label: "redispatch waste", fmt: "h", lower: true },
  { key: "expiries", label: "cache expiries", fmt: "n", lower: true },
];

/**
 * Two arms side by side, each measure with its delta.
 *
 * Figures are given per session as well as in total, because the arms rarely hold the
 * same number of runs and a total alone would read as a difference that is only a count.
 *
 * @param {object} a
 * @param {object} b
 * @returns {{label: string, a: number, b: number, delta: number|null, better: string|null}[]}
 */
export function compare(a, b) {
  return MEASURES.map((m) => {
    const av = a[m.key] || 0;
    const bv = b[m.key] || 0;
    const delta = av === 0 ? null : (bv - av) / av;
    let better = null;
    if (m.lower && delta !== null && Math.abs(delta) > 0.02)
      better = delta < 0 ? "b" : "a";
    return { ...m, a: av, b: bv, delta, better };
  });
}

/** Per-session figures, so arms with different run counts can be read against each other. */
export function perSession(stats) {
  const n = stats.sessions || 1;
  const out = { ...stats };
  for (const m of MEASURES)
    if (m.key !== "sessions") out[m.key] = (stats[m.key] || 0) / n;
  return out;
}
