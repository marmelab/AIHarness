// One session's transcripts, turned into rows.
//
// Pure functions over transcript text: no filesystem, no SQL, no clock. The CLI reads the
// files and the store writes them; everything that decides what a number MEANS lives here,
// where a test can pin it.
//
// Three attribution rules the report rests on, stated once here because a chart that
// silently gets them wrong is worse than no chart:
//
//   1. TIME is attributed per tool call, exactly: a call runs from its tool_use entry to
//      its tool_result entry. Parallel calls in one turn overlap, so an activity's
//      wall-clock is the MERGE of its intervals, never the sum of its durations. Both are
//      kept: `duration_ms` sums, `wall_ms` merges, and they differ exactly where the agent
//      batched its reads.
//
//   2. TOKENS are NOT attributable to a tool call. A turn re-reads its whole context
//      whatever it then does, so the finest honest grain is the turn, bucketed by the
//      activity that dominates its calls. Every token figure per activity is therefore an
//      approximation, and the report has to say so.
//
//   3. The GAP between two turns holds the post-tool hooks AND the next turn's generation,
//      and the transcript cannot separate them. It is reported as `wait`, and it is not
//      claimed to be hook time.

import { detectCacheExpiries, normalizeModel, price } from "./pricing.mjs";
import {
  callDetail,
  callPath,
  callSignature,
  callSummary,
  shortToolName,
  SYNTHETIC,
} from "./activity.mjs";

// Raised when a derivation changes what an already-ingested run reports, so `run-ingest
// --status` can name the runs to re-derive.
export const SCHEMA_VERSION = 3;

// A session's calendar span is not its working time. A resumed session shows days, an
// abandoned tab shows hours, and neither is harness cost: the first ingest of 78 real runs
// produced a 7567-minute "run" that was three days of an on-and-off conversation. So every
// duration is reported twice: `durationMs` is the calendar span, and `activeMs` charges a
// between-turns gap only up to this cap. Five minutes is above the slowest validation
// chain plus a turn's generation, and well below a human walking away.
export const IDLE_CAP_MS = 5 * 60 * 1000;

// The same disease on the other axis. A call's duration is `tool_result.ts - tool_use.ts`,
// which is the truth right up until a session is interrupted and resumed: the result then
// lands hours after the call, and the transcript cannot tell that from a genuinely long
// command. Drilling into one reviewer's "143 minutes of runtime" found 105 of them in a
// SINGLE `curl -m 2` that had timed out at 2 seconds. So a call's raw duration is kept and
// a CHARGED duration is capped here. Fifteen minutes is above a full e2e suite and far
// below an interrupted turn.
export const CALL_CAP_MS = 15 * 60 * 1000;

// Above this, a gap is an incident with its own cause, not coordination overhead.
export const STALL_MS = 5 * 60 * 1000;

/**
 * The quiet stretches between spans, split at STALL_MS.
 *
 * @param {[number, number][]} spans
 * @returns {{coordMs: number, stalls: {at: number, ms: number}[]}}
 */
export function splitGaps(spans) {
  const ok = spans
    .filter(
      (s) => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] >= s[0],
    )
    .sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [a, b] of ok) {
    const last = merged[merged.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else merged.push([a, b]);
  }
  let coordMs = 0;
  const stalls = [];
  for (let i = 1; i < merged.length; i++) {
    const ms = merged[i][0] - merged[i - 1][1];
    if (ms <= 0) continue;
    if (ms >= STALL_MS) stalls.push({ at: merged[i - 1][1], ms });
    else coordMs += ms;
  }
  return { coordMs, stalls: stalls.sort((a, b) => b.ms - a.ms) };
}

/** Merge [start, end] intervals and total their covered length. */
export function mergeSpans(spans) {
  const ok = spans
    .filter(
      (s) => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] >= s[0],
    )
    .sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cur = null;
  for (const [start, end] of ok) {
    if (!cur) {
      cur = [start, end];
      continue;
    }
    if (start <= cur[1]) {
      if (end > cur[1]) cur[1] = end;
      continue;
    }
    total += cur[1] - cur[0];
    cur = [start, end];
  }
  if (cur) total += cur[1] - cur[0];
  return total;
}

/** Ratio of the shared leading characters, for "is this dispatch the same one again". */
export function commonPrefixRatio(a, b) {
  const x = String(a ?? "");
  const y = String(b ?? "");
  const max = Math.max(x.length, y.length);
  if (!max) return 1;
  let i = 0;
  while (i < Math.min(x.length, y.length) && x[i] === y[i]) i++;
  return i / max;
}

const ts = (v) => {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : NaN;
};

/**
 * Parse one transcript into turns and calls.
 *
 * A "turn" is one assistant response. The transcript streams it across several lines that
 * share `message.id` and repeat the same usage, so the id is the grouping key and the
 * usage is read once: summing it per line would multiply the context by the number of
 * content blocks.
 *
 * @param {string} body raw JSONL
 * @param {(tool: string, input: unknown) => string} classify
 * @returns {{turns: object[], calls: object[]}}
 */
export function parseTranscript(body, classify) {
  const byId = new Map();
  const order = [];
  const results = new Map();
  const context = new Map();
  const hookRuns = [];
  let anon = 0;
  const len = (v) =>
    typeof v === "string" ? v.length : v == null ? 0 : JSON.stringify(v).length;
  // A snapshot states the whole current value, so the largest one is the size, never the
  // sum: adding two prompt_snapshots counted the tool definitions twice.
  const largest = (component, bytes, detail) => {
    if (!bytes) return;
    if (bytes < 1) bytes = 0; // an inventory row: recorded, but never a size
    const prev = context.get(component);
    if (!prev || bytes > prev.bytes)
      context.set(component, { component, bytes, detail });
  };

  for (const line of String(body ?? "").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const at = ts(event.timestamp);

    if (event.type === "attachment") {
      const a = event.attachment || {};
      const kind = String(a.type || "");
      if (kind === "prompt_snapshot") {
        // The tools arrive as a list of {name, description, schema}, so each one can be
        // sized on its own. "51 KB of tool definitions" is a number; "browser_snapshot
        // costs 6 KB of every turn" is a decision.
        if (Array.isArray(a.tools))
          for (const t of a.tools)
            largest(
              "tool:" + String(t?.name || "?"),
              len(t),
              String(t?.description || "").slice(0, 160) || null,
            );
        // Two thirds of a fresh agent's context is these, and neither is anything the
        // dispatch asked for. Sized separately so the bill has an addressee.
        largest("tools", len(a.tools));
        largest("system", len(a.systemPrompt));
      } else if (kind === "skill_listing") {
        largest(
          "skills",
          len(a.content),
          (a.skillCount || 0) + " skills listed",
        );
        // The listing gives no per-skill size, only names. Recorded at zero bytes on
        // purpose: an inventory to read, never a figure to add up.
        for (const name of a.names || [])
          largest("skill:" + String(name), 0.001);
      } else if (kind === "instructions") {
        largest("instructions", len(a.files));
        for (const f of a.files || [])
          largest(
            "file:" + String(f.path || f.name || "?"),
            len(f.content),
            f.path || null,
          );
      } else if (kind === "environment")
        largest("environment", len(a.snapshot));
      else if (kind === "session_context") largest("session", len(a.context));
      else if (kind === "model") largest("model", len(a.text));
      else if (kind.startsWith("hook_"))
        hookRuns.push({
          hook: String(a.hookName || "?"),
          event: String(a.hookEvent || "?"),
          ms: Number.isFinite(a.durationMs) ? a.durationMs : 0,
          exitCode: Number.isFinite(a.exitCode) ? a.exitCode : null,
          ok: kind === "hook_success",
          at,
        });
      continue;
    }

    if (event.type === "user") {
      for (const block of event.message?.content || []) {
        if (block?.type !== "tool_result" || !block.tool_use_id) continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : JSON.stringify(block.content ?? "");
        results.set(block.tool_use_id, {
          at,
          isError: block.is_error === true,
          len: text.length,
        });
      }
      continue;
    }

    if (event.type !== "assistant" || !event.message?.usage) continue;
    const usage = event.message.usage;
    const id = event.message.id || `anon-${anon++}`;
    let turn = byId.get(id);
    if (!turn) {
      turn = {
        id,
        idx: order.length,
        start: at,
        end: at,
        model: normalizeModel(event.message.model || ""),
        in: usage.input_tokens || 0,
        cacheRead: usage.cache_read_input_tokens || 0,
        cacheWrite: usage.cache_creation_input_tokens || 0,
        cw5m:
          usage.cache_creation?.ephemeral_5m_input_tokens ??
          usage.cache_creation_input_tokens ??
          0,
        cw1h: usage.cache_creation?.ephemeral_1h_input_tokens || 0,
        out: 0,
        calls: [],
      };
      byId.set(id, turn);
      order.push(turn);
    }
    // Output is the running total on each entry of the same response, not an increment.
    turn.out = Math.max(turn.out, usage.output_tokens || 0);
    if (usage.iterations)
      turn.out = usage.iterations.reduce(
        (s, it) => s + (it.output_tokens || 0),
        0,
      );
    if (Number.isFinite(at)) {
      if (!Number.isFinite(turn.start) || at < turn.start) turn.start = at;
      if (!Number.isFinite(turn.end) || at > turn.end) turn.end = at;
    }
    for (const block of event.message.content || []) {
      if (block?.type !== "tool_use") continue;
      turn.calls.push({
        id: block.id,
        tool: block.name,
        input: block.input,
        start: at,
        activity: classify(block.name, block.input),
        detail: callDetail(block.name, block.input),
        summary: callSummary(block.name, block.input),
        path: callPath(block.name, block.input),
        signature: callSignature(block.name, block.input),
      });
    }
  }

  const turns = order
    .filter((t) => Number.isFinite(t.start))
    .sort((a, b) => a.start - b.start);

  const calls = [];
  for (const [i, turn] of turns.entries()) {
    turn.idx = i;
    for (const call of turn.calls) {
      const res = results.get(call.id);
      const end = res && Number.isFinite(res.at) ? res.at : call.start;
      const rawMs = Number.isFinite(end - call.start)
        ? Math.max(0, end - call.start)
        : 0;
      const row = {
        turnIdx: i,
        toolUseId: call.id,
        tool: call.tool,
        toolShort: shortToolName(call.tool),
        activity: call.activity,
        detail: call.detail,
        summary: call.summary,
        path: call.path,
        signature: call.signature,
        start: call.start,
        end,
        durationMs: rawMs,
        chargedMs: Math.min(rawMs, CALL_CAP_MS),
        stalled: rawMs > CALL_CAP_MS,
        isError: res ? res.isError : false,
        resultLen: res ? res.len : 0,
        answered: Boolean(res),
      };
      calls.push(row);
      const chargedEnd = call.start + row.chargedMs;
      if (Number.isFinite(chargedEnd) && chargedEnd > turn.end)
        turn.end = chargedEnd;
    }
    // A turn's activity is the one most of its calls belong to. Ties break on the first
    // call, because that is the one the turn was planned around.
    const tally = new Map();
    for (const call of turn.calls)
      tally.set(call.activity, (tally.get(call.activity) || 0) + 1);
    let best = SYNTHETIC.THINK;
    let bestN = 0;
    for (const call of turn.calls) {
      const n = tally.get(call.activity) || 0;
      if (n > bestN) {
        best = call.activity;
        bestN = n;
      }
    }
    turn.activity = best;
    turn.ctx = turn.in + turn.cacheRead + turn.cacheWrite;
  }

  for (const [i, turn] of turns.entries()) {
    const prev = turns[i - 1];
    turn.waitMs =
      prev && Number.isFinite(prev.end)
        ? Math.max(0, turn.start - prev.end)
        : 0;
    // What the agent had just finished when this gap started. A wait total says an agent
    // waited; this says what for, and the two readings lead to different fixes. A gap that
    // follows a `write` turn is the validation chain; a gap on a turn that then emits a lot
    // of output is generation. Without it, "the developer's first cost is waiting" is a
    // finding with nowhere to go.
    turn.prevActivity = prev ? prev.activity : null;
  }

  return { turns, calls, context: [...context.values()], hookRuns };
}

/**
 * Hook executions, folded per hook and event.
 *
 * The transcript records every hook run with its duration and exit code, which is strictly
 * more than hooks.log holds and, unlike hooks.log, survives in the archive. A session whose
 * log was swept is not a session whose guards are unknown.
 *
 * @param {object[]} runs
 * @returns {object[]}
 */
export function rollupHookRuns(runs) {
  const rows = new Map();
  for (const r of runs) {
    const key = r.hook + "\u0000" + r.event;
    let row = rows.get(key);
    if (!row) {
      row = { hook: r.hook, event: r.event, runs: 0, ms: 0, failures: 0 };
      rows.set(key, row);
    }
    row.runs++;
    row.ms += r.ms || 0;
    if (!r.ok || (r.exitCode != null && r.exitCode !== 0)) row.failures++;
  }
  return [...rows.values()].sort((a, b) => b.ms - a.ms || b.runs - a.runs);
}

/**
 * Per-activity rollup for one agent.
 *
 * @param {object[]} turns
 * @param {object[]} calls
 * @returns {object[]}
 */
export function rollupActivities(turns, calls) {
  const rows = new Map();
  const spans = new Map();
  const row = (activity) => {
    let r = rows.get(activity);
    if (!r) {
      r = {
        activity,
        calls: 0,
        errors: 0,
        durationMs: 0,
        wallMs: 0,
        stalled: 0,
        turns: 0,
        outTokens: 0,
        resultBytes: 0,
      };
      rows.set(activity, r);
    }
    return r;
  };

  for (const call of calls) {
    const r = row(call.activity);
    r.calls++;
    if (call.isError) r.errors++;
    if (call.stalled) r.stalled++;
    r.durationMs += call.chargedMs;
    r.resultBytes += call.resultLen;
    if (!spans.has(call.activity)) spans.set(call.activity, []);
    // Capped on the span too: an uncapped end would stretch one merged interval across the
    // whole interruption and swallow every other activity inside it.
    spans.get(call.activity).push([call.start, call.start + call.chargedMs]);
  }
  for (const turn of turns) {
    const r = row(turn.activity);
    r.turns++;
    r.outTokens += turn.out;
  }
  for (const [activity, list] of spans) row(activity).wallMs = mergeSpans(list);

  // The between-turns time, split at IDLE_CAP_MS.
  //
  // `wait` is what the session plausibly spent working between two turns: the post-tool
  // hooks and the next turn's generation, which nothing in the transcript separates, so it
  // is NOT reported as hook time. `idle` is the remainder, and it is a different animal
  // entirely: a human at a gate, a tab left open, a session resumed the next morning.
  // Folding the two produced a first rollup where `wait` was 69 757 of 71 763 minutes and
  // every other activity rounded to nothing.
  let waited = 0;
  let idled = 0;
  for (const turn of turns) {
    const gap = turn.waitMs || 0;
    // ALL of a long gap is idle, not just the part past the cap. Charging its first five
    // minutes to `wait` counted the opening of every stall twice: once here as generation,
    // once at run level as an incident. Measured on two real sessions, 57% and 58% of the
    // wait bucket was that overlap, which inflated "generation" and the wait-per-minute
    // ratio built on it by the same amount.
    if (gap >= IDLE_CAP_MS) idled += gap;
    else waited += gap;
  }
  for (const [activity, ms] of [
    [SYNTHETIC.WAIT, waited],
    [SYNTHETIC.IDLE, idled],
  ]) {
    if (ms <= 0) continue;
    const r = row(activity);
    r.durationMs += ms;
    r.wallMs += ms;
  }

  return [...rows.values()].sort((a, b) => b.wallMs - a.wallMs);
}

/**
 * The spans a session was plausibly working: each turn, preceded by as much of its wait as
 * `IDLE_CAP_MS` allows. Merged by the caller, so parallel agents count once.
 *
 * @param {object[]} turns
 * @returns {[number, number][]}
 */
export function activeSpans(turns) {
  const spans = [];
  for (const turn of turns) {
    if (!Number.isFinite(turn.start)) continue;
    // Same rule: a gap long enough to be a stall buys no active time at all, rather than
    // crediting the run with the cap for each one.
    const gap = turn.waitMs || 0;
    const charged = gap >= IDLE_CAP_MS ? 0 : gap;
    const end = Number.isFinite(turn.end) ? turn.end : turn.start;
    spans.push([turn.start - charged, Math.max(end, turn.start)]);
  }
  return spans;
}

const LOOP_MIN_REPEATS = 2;
const REREAD_MIN = 3;
const RETRY_SIMILARITY = 0.8;

/**
 * Going in circles: the same work done again.
 *
 * Four shapes, each reported separately because they have different cures. A repeated
 * identical call is a memory failure; a re-read is a context that fell out; a retry after
 * an error is the agent fighting the environment; a duplicate dispatch is the harness
 * spending an agent twice on one job.
 *
 * @param {object[]} calls
 * @returns {object[]}
 */
export function detectLoops(calls) {
  const out = [];

  const bySignature = new Map();
  for (const call of calls) {
    if (!bySignature.has(call.signature)) bySignature.set(call.signature, []);
    bySignature.get(call.signature).push(call);
  }
  for (const [, list] of bySignature) {
    if (list.length < LOOP_MIN_REPEATS) continue;
    const first = list[0];
    // A dispatch repeated verbatim is a duplicate dispatch, which is its own finding.
    const kind =
      first.activity === "dispatch" ? "duplicate-dispatch" : "repeat-call";
    out.push({
      kind,
      tool: first.tool,
      activity: first.activity,
      count: list.length,
      wastedMs: list.slice(1).reduce((s, c) => s + c.chargedMs, 0),
      detail: first.detail,
      firstTurn: first.turnIdx,
      lastTurn: list[list.length - 1].turnIdx,
    });
  }

  const reads = new Map();
  for (const call of calls) {
    if (call.tool !== "Read" || !call.path) continue;
    reads.set(call.path, (reads.get(call.path) || []).concat([call]));
  }
  for (const [path, list] of reads) {
    if (list.length < REREAD_MIN) continue;
    out.push({
      kind: "reread",
      tool: "Read",
      activity: "explore",
      count: list.length,
      wastedMs: list.slice(1).reduce((s, c) => s + c.chargedMs, 0),
      detail: path,
      firstTurn: list[0].turnIdx,
      lastTurn: list[list.length - 1].turnIdx,
    });
  }

  for (const [i, call] of calls.entries()) {
    if (!call.isError) continue;
    const next = calls
      .slice(i + 1)
      .find((c) => c.tool === call.tool && c.signature !== call.signature);
    if (!next) continue;
    const a = call.detail ?? "";
    const b = next.detail ?? "";
    if (!a || !b || commonPrefixRatio(a, b) < RETRY_SIMILARITY) continue;
    out.push({
      kind: "error-retry",
      tool: call.tool,
      activity: call.activity,
      count: 2,
      wastedMs: call.chargedMs,
      detail: a,
      firstTurn: call.turnIdx,
      lastTurn: next.turnIdx,
    });
  }

  return out.sort((x, y) => y.wastedMs - x.wastedMs || y.count - x.count);
}

/**
 * The name Claude Code gave the session, as `/resume` shows it.
 *
 * Three sources, in order of how well they name a run:
 *
 *   1. `ai-title` entries in the main transcript. They are REFINED as the session goes —
 *      one archived session carries forty — so the last one wins.
 *   2. the slash command the session opened on. Six sessions in sixty have no title at
 *      all, and every one of them started with a command; `/dev-review delta 156` names
 *      the run better than any id does.
 *   3. the first thing the user actually typed.
 *
 * The framing a session opens with is never a name: the `<command-message>` block, the
 * caveat, and the body of a skill the command pulled in. A first pass that took the first
 * user text verbatim titled eight preschool-crm runs "Base directory for this skill:
 * /home/node/.claude/skills/dev-review", which is the skill talking, not the user.
 *
 * @param {string} body raw JSONL of the main transcript
 * @returns {string|null}
 */
const INJECTED =
  /^(Base directory for this skill|Caveat:|<|\s*$)|^[\s\S]{0,80}\/skills\//;

export function sessionTitle(body) {
  let title = null;
  let command = null;
  let args = null;
  let typed = null;

  for (const line of String(body ?? "").split("\n")) {
    if (!line.trim()) continue;
    // Cheap guards before parsing: a main transcript is megabytes of lines that are none
    // of these.
    const maybeTitle = line.includes('"ai-title"');
    if (!maybeTitle && typed && command) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === "ai-title") {
      if (typeof event.aiTitle === "string" && event.aiTitle.trim())
        title = event.aiTitle.trim();
      continue;
    }
    if (event.type !== "user") continue;
    const c = event.message?.content;
    const text =
      typeof c === "string"
        ? c
        : Array.isArray(c)
          ? c
              .filter((b) => b?.type === "text" && typeof b.text === "string")
              .map((b) => b.text)
              .join(" ")
          : "";
    if (!text) continue;
    if (command === null) {
      const name = text.match(/<command-name>([^<]+)<\/command-name>/);
      if (name) {
        command = name[1].trim();
        const a = text.match(/<command-args>([^<]*)<\/command-args>/);
        args = a ? a[1].trim() : "";
      }
    }
    if (typed === null) {
      const clean = text.trim().replace(/\s+/g, " ");
      if (clean && !INJECTED.test(clean)) typed = clean.slice(0, 80);
    }
  }

  if (title) return title;
  if (command) return (command + " " + (args || "")).trim();
  return typed;
}

/**
 * Fold one agent's transcript into the shape the store writes.
 *
 * @param {object} args
 * @param {string} args.agentId
 * @param {string} args.body raw JSONL
 * @param {object} [args.meta] the sidecar .meta.json, when there is one
 * @param {(tool: string, input: unknown) => string} args.classify
 * @returns {object}
 */
export function buildAgent({ agentId, body, meta = {}, classify }) {
  const { turns, calls, context, hookRuns } = parseTranscript(body, classify);
  const models = [...new Set(turns.map((t) => t.model).filter(Boolean))];
  // Priced per turn, because a run's window may hold only some of an agent's turns and a
  // total cannot be split after the fact.
  for (const t of turns)
    t.usd = price({
      in: t.in,
      out: t.out,
      cacheRead: t.cacheRead,
      cw5m: t.cw5m,
      cw1h: t.cw1h,
      model: t.model,
    }).total;
  const totals = turns.reduce(
    (acc, t) => {
      acc.in += t.in;
      acc.out += t.out;
      acc.cacheRead += t.cacheRead;
      acc.cw5m += t.cw5m;
      acc.cw1h += t.cw1h;
      return acc;
    },
    { in: 0, out: 0, cacheRead: 0, cw5m: 0, cw1h: 0 },
  );
  // Summed per turn, each at ITS OWN model's rate. Pricing the agent's totals at one
  // model priced whatever that model happened to be for every token: on a main thread
  // alternating opus and fable, 254 turns were billed at the fable rate and the agent
  // reported $204 where the turns add up to $125.
  const usd = {
    total: turns.reduce((sum, t) => sum + (t.usd || 0), 0),
    rateKnown: turns.every(
      (t) =>
        price({
          in: t.in,
          out: t.out,
          cacheRead: t.cacheRead,
          cw5m: t.cw5m,
          cw1h: t.cw1h,
          model: t.model,
        }).rateKnown,
    ),
  };
  const expiries = detectCacheExpiries(
    turns.map((t) => ({
      ts: t.start,
      in: t.in,
      cw: t.cacheWrite,
      cr: t.cacheRead,
    })),
  );
  const toolTurns = turns.filter((t) => t.calls.length).length;
  const agentType = String(meta.agentType || "");

  return {
    agentId,
    agentType,
    // "aiharness:developer" and "developer" are the same role; the plugin prefix is
    // packaging, not identity.
    role: agentType.includes(":")
      ? agentType.split(":").pop()
      : agentType || "main",
    description: meta.description || null,
    parentToolUseId: meta.toolUseId || null,
    spawnDepth: Number.isFinite(meta.spawnDepth) ? meta.spawnDepth : null,
    requestShape: meta.requestShape || null,
    model: models[0] || "",
    models,
    turns: turns.length,
    toolTurns,
    thinkTurns: turns.length - toolTurns,
    calls: calls.length,
    errors: calls.filter((c) => c.isError).length,
    ctxFirst: turns[0]?.ctx || 0,
    ctxLast: turns[turns.length - 1]?.ctx || 0,
    ctxMax: turns.reduce((m, t) => Math.max(m, t.ctx), 0),
    // The billing unit: what one API call actually re-reads, averaged.
    ctxPerCall: turns.length ? Math.round(totals.cacheRead / turns.length) : 0,
    inTokens: totals.in,
    outTokens: totals.out,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cw5m + totals.cw1h,
    usd: usd.total,
    rateKnown: usd.rateKnown,
    expiries: expiries.count,
    expiredTokens: expiries.tokens,
    startedAt: turns[0]?.start ?? null,
    endedAt: turns.length ? Math.max(...turns.map((t) => t.end)) : null,
    durationMs:
      turns.length && Number.isFinite(turns[0].start)
        ? Math.max(...turns.map((t) => t.end)) - turns[0].start
        : 0,
    waitMs: turns.reduce((s, t) => s + (t.waitMs || 0), 0),
    activeMs: mergeSpans(activeSpans(turns)),
    idleMs: turns.reduce(
      (s, t) => s + Math.max(0, (t.waitMs || 0) - IDLE_CAP_MS),
      0,
    ),
    turnRows: turns.map((t) => ({
      idx: t.idx,
      at: t.start,
      endAt: t.end,
      model: t.model,
      activity: t.activity,
      prevActivity: t.prevActivity ?? null,
      ctx: t.ctx,
      inTokens: t.in,
      cacheRead: t.cacheRead,
      cacheWrite: t.cacheWrite,
      outTokens: t.out,
      calls: t.calls.length,
      waitMs: t.waitMs || 0,
      usd: t.usd || 0,
    })),
    callRows: calls,
    activityRows: rollupActivities(turns, calls),
    loopRows: detectLoops(calls),
    contextRows: context,
    hookRows: rollupHookRuns(hookRuns),
  };
}

/**
 * Cross-agent loops: two dispatches that asked for the same thing.
 *
 * Within one agent `detectLoops` already catches a verbatim repeat. This catches the other
 * shape, where the orchestrator dispatched twice with descriptions that are merely near
 * identical, which is what a retry after a swallowed failure looks like.
 *
 * @param {object[]} agents
 * @returns {object[]}
 */
export function detectRedispatches(agents) {
  const sorted = agents
    .filter((a) => a.description && Number.isFinite(a.startedAt))
    .sort((a, b) => a.startedAt - b.startedAt);
  const out = [];
  const seen = new Set();
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const a = sorted[i];
      const b = sorted[j];
      if (seen.has(b.agentId)) continue;
      if (a.role !== b.role) continue;
      if (commonPrefixRatio(a.description, b.description) < RETRY_SIMILARITY)
        continue;
      seen.add(b.agentId);
      out.push({
        kind: "redispatch",
        role: b.role,
        first: a.agentId,
        again: b.agentId,
        description: b.description,
        wastedMs: a.durationMs,
        usd: a.usd,
      });
    }
  }
  return out;
}

/**
 * Fold a whole session into the shape the store writes.
 *
 * Pure: the caller does the reading, so a test builds a run from strings and the CLI
 * builds the same run from files.
 *
 * @param {object} args
 * @param {string} args.sessionId
 * @param {string} args.slug
 * @param {string} [args.mainBody] the main thread's transcript
 * @param {{agentId: string, body: string, meta?: object}[]} [args.agents]
 * @param {string} [args.hooksLog]
 * @param {(tool: string, input: unknown) => string} args.classify
 * @param {object} [args.tags] arm / label / harnessVersion / sourcePath
 * @param {Set<string> | null} [args.harnessRoles] the bare roles that open a run window;
 *   null lets every subagent open it
 * @param {boolean} [args.whole] count the whole session, never a window
 * @returns {object}
 */
export function buildRun({
  sessionId,
  slug,
  mainBody = "",
  agents = [],
  hooksLog = "",
  classify,
  tags = {},
  harnessRoles = null,
  whole = false,
}) {
  const rows = [];
  if (mainBody.trim())
    rows.push(
      buildAgent({
        agentId: "main",
        body: mainBody,
        meta: { agentType: "main" },
        classify,
      }),
    );
  for (const a of agents)
    rows.push(
      buildAgent({
        agentId: a.agentId,
        body: a.body,
        meta: a.meta || {},
        classify,
      }),
    );

  const withTurns = rows.filter((a) => a.turns > 0);

  // THE RUN WINDOW. A session is not a run. When a session dispatched harness agents, the
  // run is the span those agents cover; what the main thread did before or after is the
  // developer's own interactive work, and charging it to the harness makes the main thread
  // look like the most expensive role of every pipeline. Only a harness role opens the
  // window: an Explore or a review fan-out in an ordinary session is that session's work,
  // not a run inside it. With no harness agent, or with `whole`, the run IS the session.
  const spawned = whole
    ? []
    : withTurns.filter(
        (a) =>
          a.agentId !== "main" && (!harnessRoles || harnessRoles.has(a.role)),
      );
  const windowStart = spawned.length
    ? Math.min(...spawned.map((a) => a.startedAt).filter(Number.isFinite))
    : null;
  const windowEnd = spawned.length
    ? Math.max(...spawned.map((a) => a.endedAt).filter(Number.isFinite))
    : null;
  const inWindow = (at) =>
    windowStart == null || (at >= windowStart && at <= windowEnd);

  for (const a of rows) {
    const kept = a.turnRows.filter(
      (t) => Number.isFinite(t.at) && inWindow(t.at),
    );
    a.turnsInWindow = kept.length;
    a.usdInWindow = kept.reduce((sum, t) => sum + (t.usd || 0), 0);
    a.callsInWindow = a.callRows.filter(
      (c) => Number.isFinite(c.start) && inWindow(c.start),
    ).length;
    a.outsideTurns = a.turns - a.turnsInWindow;
    a.outsideUsd = a.usd - a.usdInWindow;
  }

  const starts = withTurns.map((a) => a.startedAt).filter(Number.isFinite);
  const ends = withTurns.map((a) => a.endedAt).filter(Number.isFinite);
  const startedAt = starts.length ? Math.min(...starts) : null;
  const endedAt = ends.length ? Math.max(...ends) : null;
  // Merged across agents: two developers working at the same time cost one wall-clock
  // minute, not two. Summing their `activeMs` would double the run's length.
  // Time inside the window during which AT LEAST ONE agent was producing a turn. What the
  // window holds and this does not is dead time: nobody working, which on a dispatch-driven
  // harness is the orchestrator's turnaround between one agent stopping and the next
  // starting. It is the one latency figure the harness itself can do something about.
  // The gaps INSIDE the window where no agent had a turn in flight, split at the stall
  // threshold. One number for both was useless: on a measured run, 86% of the 128 dead
  // minutes were three gaps, one of them 90 minutes long, while the 183 short gaps that
  // actually are the orchestrator's turnaround came to 17. A mean over those two
  // populations describes neither.
  //
  // Recorded hook executions are NOT the explanation: 1544 of them totalled 0.8 min on that
  // run. But SubagentStop hooks do not appear in a transcript at all, so a validation chain
  // running on a developer's stop lands here with nothing to name it. Anything above the
  // threshold is reported as an incident to open, never as a rate.
  const turnSpans = rows.flatMap((a) =>
    a.turnRows
      .filter((t) => inWindow(t.at))
      .map((t) => [t.at, Math.max(t.endAt ?? t.at, t.at)]),
  );
  const { coordMs, stalls } = splitGaps(turnSpans);
  const stallsMs = stalls.reduce((sum, g) => sum + g.ms, 0);

  const windowSpanMs =
    windowStart != null && windowEnd != null ? windowEnd - windowStart : 0;
  // Every span this run measures is clipped to the window it is measured against. A turn
  // that begins inside it can end well after, and a turn's active span is extended
  // backwards by the wait it charges: both overhang, and an overhang makes busy exceed the
  // window and the dead time go negative.
  const clamp = ([a, b]) =>
    windowStart == null
      ? [a, b]
      : [
          Math.max(a, windowStart),
          Math.max(Math.min(b, windowEnd), Math.max(a, windowStart)),
        ];

  const busyMs = mergeSpans(
    rows
      .flatMap((a) =>
        a.turnRows
          .filter((t) => inWindow(t.at))
          .map((t) => [t.at, Math.max(t.endAt ?? t.at, t.at)]),
      )
      .map(clamp),
  );

  const activeMs = mergeSpans(
    rows
      .flatMap((a) =>
        activeSpans(
          a.turnRows
            .filter((t) => inWindow(t.at))
            .map((t) => ({ start: t.at, end: t.endAt, waitMs: t.waitMs })),
        ),
      )
      .map(clamp),
  );

  return {
    sessionId,
    slug,
    title: sessionTitle(mainBody),
    arm: tags.arm ?? null,
    label: tags.label ?? null,
    harnessVersion: tags.harnessVersion ?? null,
    sourcePath: tags.sourcePath ?? null,
    schemaVersion: SCHEMA_VERSION,
    startedAt,
    endedAt,
    windowStart,
    windowEnd,
    durationMs: startedAt != null && endedAt != null ? endedAt - startedAt : 0,
    activeMs,
    busyMs,
    // The measured sum of the short gaps, NOT the window minus everything else. A residual
    // is defined to make the identity hold, so it can absorb an error silently; this can
    // disagree, and the test that asserts coordination + stalls == window - busy is what
    // catches it when it does.
    coordMs,
    stalls,
    stallMs: stallsMs,
    windowMs:
      windowSpanMs ||
      (startedAt != null && endedAt != null ? endedAt - startedAt : 0),
    agents: rows,
    // What the session did outside the run, kept as its own figure rather than folded in
    // or thrown away: it is real spend, it is just not the harness's.
    hostTurns: rows.reduce((sum, a) => sum + a.outsideTurns, 0),
    hostUsd: rows.reduce((sum, a) => sum + a.outsideUsd, 0),
    turnCount: rows.reduce((s, a) => s + a.turnsInWindow, 0),
    callCount: rows.reduce((s, a) => s + a.callsInWindow, 0),
    errorCount: rows.reduce((s, a) => s + a.errors, 0),
    usd: rows.reduce((s, a) => s + a.usdInWindow, 0),
    rateKnown: rows.every((a) => a.rateKnown),
    hasHooksLog: Boolean(hooksLog.trim()),
    hooks: rollupHooks(hooksLog),
    hookEvents: hookEvents(hooksLog),
    redispatches: detectRedispatches(rows.filter((a) => a.agentId !== "main")),
  };
}

/**
 * Parse a hooks.log line. Grammar: `[iso] [hook-name] message`, set by
 * hooks/lib/context.mjs, which prefixes EVERY line including continuations.
 *
 * @param {string} line
 * @returns {{at: number, hook: string, message: string}|null}
 */
export function parseHookLine(line) {
  const m = String(line ?? "").match(
    /^\[([^\]]+)\]\s+\[([^\]]+)\]\s?([\s\S]*)$/,
  );
  if (!m) return null;
  const at = ts(m[1]);
  if (!Number.isFinite(at)) return null;
  return { at, hook: m[2], message: m[3] ?? "" };
}

/**
 * Every hooks.log line, timestamped.
 *
 * This is the only record of a SubagentStop hook. The transcript carries PreToolUse and
 * PostToolUse executions with their durations, but nothing at all for the hooks that run
 * when an agent stops, which is where the validation chain lives. So a five-minute quiet
 * stretch that was really a typecheck plus a test suite is indistinguishable from a human
 * walking away, unless this file survived. It lives under $HARNESS_TMP_ROOT, /tmp by
 * default, and /tmp is swept: that is a configuration worth changing, not a limit.
 *
 * @param {string} text
 * @returns {{at: number, hook: string, message: string}[]}
 */
export function hookEvents(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const parsed = parseHookLine(line);
    if (parsed) out.push(parsed);
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Hook activity, folded per hook name. */
export function rollupHooks(text) {
  const rows = new Map();
  for (const line of String(text ?? "").split("\n")) {
    const parsed = parseHookLine(line);
    if (!parsed) continue;
    let r = rows.get(parsed.hook);
    if (!r) {
      r = {
        hook: parsed.hook,
        lines: 0,
        blocks: 0,
        firstAt: parsed.at,
        lastAt: parsed.at,
      };
      rows.set(parsed.hook, r);
    }
    r.lines++;
    // A refusal is the event worth counting: it is the only line that changed what an
    // agent was allowed to do.
    if (
      /\b(BLOCK|BLOCKED|DENY|DENIED|REFUS|refused|rejected)\b/i.test(
        parsed.message,
      )
    )
      r.blocks++;
    if (parsed.at < r.firstAt) r.firstAt = parsed.at;
    if (parsed.at > r.lastAt) r.lastAt = parsed.at;
  }
  return [...rows.values()].sort(
    (a, b) => b.blocks - a.blocks || b.lines - a.lines,
  );
}
