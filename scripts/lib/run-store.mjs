// The run store: one SQLite file holding every ingested session.
//
// SQLite rather than a pile of JSON because the point of the store is the question nobody
// has asked yet. "Did the reviewer's exploration share grow after we shrank its prompt"
// is one SELECT over runs already ingested, and no report format anticipates it.
// `node:sqlite` is a builtin on Node 22.5+, so this keeps the repo's no-runtime-dependency
// rule intact.
//
// Ingestion is IDEMPOTENT by session id: re-ingesting replaces that run's rows wholesale.
// That is not a convenience, it is the design. The transcripts are immutable and archived,
// the derivation is not: every time this file's logic improves, the whole archive is
// re-derived with one command, and old runs stay comparable with new ones instead of
// being frozen at whatever the ingester understood on the day they ran.

import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export const STORE_SCHEMA = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS runs (
  session_id     TEXT PRIMARY KEY,
  slug           TEXT NOT NULL,
  title          TEXT,
  arm            TEXT,
  label          TEXT,
  harness_version TEXT,
  started_at     INTEGER,
  ended_at       INTEGER,
  duration_ms    INTEGER,
  active_ms      INTEGER,
  busy_ms        INTEGER,
  coord_ms       INTEGER,
  stall_ms       INTEGER,
  stall_count    INTEGER,
  window_ms      INTEGER,
  window_start   INTEGER,
  window_end     INTEGER,
  host_turns     INTEGER,
  host_usd       REAL,
  agent_count    INTEGER,
  turn_count     INTEGER,
  call_count     INTEGER,
  error_count    INTEGER,
  usd            REAL,
  rate_known     INTEGER,
  has_hooks_log  INTEGER,
  source_path    TEXT,
  schema_version INTEGER,
  ingested_at    INTEGER
);

CREATE TABLE IF NOT EXISTS agents (
  session_id      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  role            TEXT,
  agent_type      TEXT,
  description     TEXT,
  parent_tool_use_id TEXT,
  spawn_depth     INTEGER,
  request_shape   TEXT,
  model           TEXT,
  turns           INTEGER,
  tool_turns      INTEGER,
  think_turns     INTEGER,
  calls           INTEGER,
  errors          INTEGER,
  ctx_first       INTEGER,
  ctx_last        INTEGER,
  ctx_max         INTEGER,
  ctx_per_call    INTEGER,
  in_tokens       INTEGER,
  out_tokens      INTEGER,
  cache_read      INTEGER,
  cache_write     INTEGER,
  usd             REAL,
  expiries        INTEGER,
  expired_tokens  INTEGER,
  started_at      INTEGER,
  ended_at        INTEGER,
  duration_ms     INTEGER,
  active_ms       INTEGER,
  turns_in_window INTEGER,
  calls_in_window INTEGER,
  usd_in_window   REAL,
  outside_turns   INTEGER,
  outside_usd     REAL,
  wait_ms         INTEGER,
  idle_ms         INTEGER,
  PRIMARY KEY (session_id, agent_id)
);

CREATE TABLE IF NOT EXISTS turns (
  session_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  idx          INTEGER NOT NULL,
  at           INTEGER,
  end_at       INTEGER,
  model        TEXT,
  activity     TEXT,
  prev_activity TEXT,
  ctx          INTEGER,
  in_tokens    INTEGER,
  cache_read   INTEGER,
  cache_write  INTEGER,
  out_tokens   INTEGER,
  calls        INTEGER,
  wait_ms      INTEGER,
  usd          REAL,
  PRIMARY KEY (session_id, agent_id, idx)
);

CREATE TABLE IF NOT EXISTS calls (
  session_id  TEXT NOT NULL,
  agent_id    TEXT NOT NULL,
  turn_idx    INTEGER,
  tool_use_id TEXT,
  tool        TEXT,
  tool_short  TEXT,
  activity    TEXT,
  summary     TEXT,
  detail      TEXT,
  path        TEXT,
  at          INTEGER,
  end_at      INTEGER,
  duration_ms INTEGER,
  charged_ms  INTEGER,
  stalled     INTEGER,
  is_error    INTEGER,
  result_len  INTEGER
);

CREATE TABLE IF NOT EXISTS activities (
  session_id   TEXT NOT NULL,
  agent_id     TEXT NOT NULL,
  activity     TEXT NOT NULL,
  calls        INTEGER,
  errors       INTEGER,
  duration_ms  INTEGER,
  wall_ms      INTEGER,
  stalled      INTEGER,
  turns        INTEGER,
  out_tokens   INTEGER,
  result_bytes INTEGER,
  PRIMARY KEY (session_id, agent_id, activity)
);

CREATE TABLE IF NOT EXISTS loops (
  session_id TEXT NOT NULL,
  agent_id   TEXT,
  kind       TEXT,
  tool       TEXT,
  activity   TEXT,
  count      INTEGER,
  wasted_ms  INTEGER,
  detail     TEXT,
  first_turn INTEGER,
  last_turn  INTEGER
);

-- Hook activity, folded per hook and event. The transcript records every execution with
-- its duration and exit code, so this survives even when the session's hooks.log was swept
-- off /tmp; the lines and blocks columns come from that log when archived.
CREATE TABLE IF NOT EXISTS hooks (
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL DEFAULT '',
  hook       TEXT NOT NULL,
  event      TEXT NOT NULL DEFAULT '',
  runs       INTEGER,
  ms         INTEGER,
  failures   INTEGER,
  lines      INTEGER,
  blocks     INTEGER,
  PRIMARY KEY (session_id, agent_id, hook, event)
);

-- What an agent's context was made of before it read a single line of its task.
-- One row per hooks.log line. The only trace a SubagentStop hook leaves anywhere, and so
-- the only way to tell a validation chain from a human walking away.
CREATE TABLE IF NOT EXISTS hook_events (
  session_id TEXT NOT NULL,
  at         INTEGER,
  hook       TEXT,
  message    TEXT
);

CREATE INDEX IF NOT EXISTS hook_events_by_at ON hook_events (session_id, at);

-- The quiet stretches worth opening one by one, rather than averaging into a rate.
CREATE TABLE IF NOT EXISTS stalls (
  session_id TEXT NOT NULL,
  at         INTEGER,
  ms         INTEGER
);

CREATE TABLE IF NOT EXISTS context (
  session_id TEXT NOT NULL,
  agent_id   TEXT NOT NULL,
  component  TEXT NOT NULL,
  bytes      INTEGER,
  detail     TEXT,
  PRIMARY KEY (session_id, agent_id, component)
);

CREATE INDEX IF NOT EXISTS calls_by_agent ON calls (session_id, agent_id);
CREATE INDEX IF NOT EXISTS calls_by_activity ON calls (activity);
CREATE INDEX IF NOT EXISTS calls_by_tool ON calls (tool_short);
CREATE INDEX IF NOT EXISTS turns_by_prev ON turns (prev_activity);
CREATE INDEX IF NOT EXISTS calls_by_path ON calls (path);
CREATE INDEX IF NOT EXISTS agents_by_role ON agents (role);
CREATE INDEX IF NOT EXISTS loops_by_kind ON loops (kind);
CREATE INDEX IF NOT EXISTS context_by_component ON context (component);
`;

// Every table keyed by session_id, so a re-ingestion replaces a session instead of adding
// a second copy of it. An omission here is silent: `stalls` was missing and the archive
// held every stall twice, which no aggregate on `runs` could show because those columns
// are computed, not summed from the detail.
export const CHILD_TABLES = [
  "agents",
  "turns",
  "calls",
  "activities",
  "loops",
  "hooks",
  "hook_events",
  "stalls",
  "context",
];

/**
 * Open (creating if needed) the store.
 * @param {string} file
 * @returns {import("node:sqlite").DatabaseSync}
 */
export function openStore(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec(DDL);
  db.exec(
    `CREATE TABLE IF NOT EXISTS store_meta (key TEXT PRIMARY KEY, value TEXT)`,
  );
  db.prepare(
    `INSERT INTO store_meta (key, value) VALUES ('schema_version', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(String(STORE_SCHEMA));
  return db;
}

const bool = (v) => (v ? 1 : 0);
const num = (v) => (Number.isFinite(v) ? Math.round(v) : null);

/**
 * Write one run, replacing any previous ingestion of the same session.
 *
 * @param {import("node:sqlite").DatabaseSync} db
 * @param {object} run  the shape buildRun produces
 * @returns {{agents: number, turns: number, calls: number}}
 */
export function writeRun(db, run) {
  const del = (table) =>
    db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(run.sessionId);
  db.exec("BEGIN");
  try {
    for (const table of CHILD_TABLES) del(table);
    db.prepare(`DELETE FROM runs WHERE session_id = ?`).run(run.sessionId);

    db.prepare(
      `INSERT INTO runs (session_id, slug, title, arm, label, harness_version, started_at,
         ended_at, duration_ms, active_ms, busy_ms, coord_ms, stall_ms, stall_count,
         window_ms, window_start, window_end, host_turns, host_usd, agent_count,
         turn_count, call_count, error_count, usd, rate_known, has_hooks_log, source_path,
         schema_version, ingested_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      run.sessionId,
      run.slug,
      run.title ?? null,
      run.arm ?? null,
      run.label ?? null,
      run.harnessVersion ?? null,
      num(run.startedAt),
      num(run.endedAt),
      num(run.durationMs),
      num(run.activeMs),
      num(run.busyMs),
      num(run.coordMs),
      num(run.stallMs),
      (run.stalls || []).length,
      num(run.windowMs),
      num(run.windowStart),
      num(run.windowEnd),
      run.hostTurns,
      run.hostUsd,
      run.agents.length,
      run.turnCount,
      run.callCount,
      run.errorCount,
      run.usd,
      bool(run.rateKnown),
      bool(run.hasHooksLog),
      run.sourcePath ?? null,
      run.schemaVersion,
      Date.now(),
    );

    const insAgent = db.prepare(
      `INSERT INTO agents (session_id, agent_id, role, agent_type, description,
         parent_tool_use_id, spawn_depth, request_shape, model, turns, tool_turns,
         think_turns, calls, errors, ctx_first, ctx_last, ctx_max, ctx_per_call,
         in_tokens, out_tokens, cache_read, cache_write, usd, expiries, expired_tokens,
         started_at, ended_at, duration_ms, active_ms, turns_in_window,
         calls_in_window, usd_in_window, outside_turns, outside_usd, wait_ms, idle_ms)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insTurn = db.prepare(
      `INSERT INTO turns (session_id, agent_id, idx, at, end_at, model, activity,
         prev_activity, ctx, in_tokens, cache_read, cache_write, out_tokens, calls,
         wait_ms, usd)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insCall = db.prepare(
      `INSERT INTO calls (session_id, agent_id, turn_idx, tool_use_id, tool, tool_short,
         activity, summary, detail, path, at, end_at, duration_ms, charged_ms,
         stalled, is_error, result_len)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insActivity = db.prepare(
      `INSERT INTO activities (session_id, agent_id, activity, calls, errors, duration_ms,
         wall_ms, stalled, turns, out_tokens, result_bytes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const insLoop = db.prepare(
      `INSERT INTO loops (session_id, agent_id, kind, tool, activity, count, wasted_ms,
         detail, first_turn, last_turn)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
    );
    const insHook = db.prepare(
      `INSERT INTO hooks (session_id, agent_id, hook, event, runs, ms, failures, lines,
         blocks)
       VALUES (?,?,?,?,?,?,?,?,?)
       ON CONFLICT(session_id, agent_id, hook, event) DO UPDATE SET
         runs = runs + excluded.runs, ms = ms + excluded.ms,
         failures = failures + excluded.failures`,
    );
    const insContext = db.prepare(
      `INSERT INTO context (session_id, agent_id, component, bytes, detail)
       VALUES (?,?,?,?,?)
       ON CONFLICT(session_id, agent_id, component) DO UPDATE SET
         bytes = max(bytes, excluded.bytes)`,
    );

    for (const a of run.agents) {
      insAgent.run(
        run.sessionId,
        a.agentId,
        a.role,
        a.agentType,
        a.description,
        a.parentToolUseId,
        a.spawnDepth,
        a.requestShape,
        a.model,
        a.turns,
        a.toolTurns,
        a.thinkTurns,
        a.calls,
        a.errors,
        a.ctxFirst,
        a.ctxLast,
        a.ctxMax,
        a.ctxPerCall,
        a.inTokens,
        a.outTokens,
        a.cacheRead,
        a.cacheWrite,
        a.usd,
        a.expiries,
        a.expiredTokens,
        num(a.startedAt),
        num(a.endedAt),
        num(a.durationMs),
        num(a.activeMs),
        a.turnsInWindow,
        a.callsInWindow,
        a.usdInWindow,
        a.outsideTurns,
        a.outsideUsd,
        num(a.waitMs),
        num(a.idleMs),
      );
      for (const t of a.turnRows)
        insTurn.run(
          run.sessionId,
          a.agentId,
          t.idx,
          num(t.at),
          num(t.endAt),
          t.model,
          t.activity,
          t.prevActivity,
          t.ctx,
          t.inTokens,
          t.cacheRead,
          t.cacheWrite,
          t.outTokens,
          t.calls,
          num(t.waitMs),
          t.usd || 0,
        );
      for (const c of a.callRows)
        insCall.run(
          run.sessionId,
          a.agentId,
          c.turnIdx,
          c.toolUseId ?? null,
          c.tool,
          c.toolShort,
          c.activity,
          c.summary,
          c.detail,
          c.path,
          num(c.start),
          num(c.end),
          num(c.durationMs),
          num(c.chargedMs),
          bool(c.stalled),
          bool(c.isError),
          c.resultLen,
        );
      for (const r of a.activityRows)
        insActivity.run(
          run.sessionId,
          a.agentId,
          r.activity,
          r.calls,
          r.errors,
          num(r.durationMs),
          num(r.wallMs),
          r.stalled,
          r.turns,
          r.outTokens,
          r.resultBytes,
        );
      for (const h of a.hookRows || [])
        insHook.run(
          run.sessionId,
          a.agentId,
          h.hook,
          h.event,
          h.runs,
          num(h.ms),
          h.failures,
          0,
          0,
        );
      for (const c of a.contextRows || [])
        insContext.run(
          run.sessionId,
          a.agentId,
          c.component,
          c.bytes,
          c.detail ?? null,
        );
      for (const l of a.loopRows)
        insLoop.run(
          run.sessionId,
          a.agentId,
          l.kind,
          l.tool,
          l.activity,
          l.count,
          num(l.wastedMs),
          l.detail,
          l.firstTurn,
          l.lastTurn,
        );
    }

    for (const l of run.redispatches || [])
      insLoop.run(
        run.sessionId,
        l.again,
        l.kind,
        null,
        "dispatch",
        1,
        num(l.wastedMs),
        l.description,
        null,
        null,
      );

    // From the archived hooks.log, when there was one: it is the only source for a refusal
    // message, which the transcript's hook attachment does not carry.
    const insHookEvent = db.prepare(
      `INSERT INTO hook_events (session_id, at, hook, message) VALUES (?,?,?,?)`,
    );
    for (const e of run.hookEvents || [])
      insHookEvent.run(
        run.sessionId,
        num(e.at),
        e.hook,
        e.message.slice(0, 300),
      );

    const insStall = db.prepare(
      `INSERT INTO stalls (session_id, at, ms) VALUES (?,?,?)`,
    );
    for (const g of run.stalls || [])
      insStall.run(run.sessionId, num(g.at), num(g.ms));

    for (const h of run.hooks || [])
      insHook.run(run.sessionId, "", h.hook, "", 0, 0, 0, h.lines, h.blocks);

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  return {
    agents: run.agents.length,
    turns: run.turnCount,
    calls: run.callCount,
  };
}

/** Session ids already in the store, with the schema they were derived under. */
export function ingestedRuns(db) {
  return db
    .prepare(
      `SELECT session_id, schema_version, ingested_at FROM runs ORDER BY started_at`,
    )
    .all();
}
