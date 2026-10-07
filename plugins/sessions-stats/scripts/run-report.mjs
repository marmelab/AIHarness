#!/usr/bin/env node
// One run under the microscope, rendered as a dense instrument panel.
//
// The layout is an observability dashboard, not an article: a grid of small panels, each
// answering one question, with the number large enough to read from across the desk. That
// is the shape this data wants, and it is the shape the team already reads elsewhere.
//
// Two rules the page exists to respect, both learned by getting them wrong:
//
//   IDLE IS NEVER A BAR. The archive holds 47 days of sessions left open. Charted beside
//   real work it is three orders of magnitude larger and flattens everything else into a
//   hairline. It gets one tile, named as excluded, and appears nowhere else.
//
//   WAIT IS NOT AN ACTIVITY. The gap between turns is generation plus hooks, so it belongs
//   in the run's time composition but not in the breakdown of what the agent DID. Mixing
//   the two produced a chart whose biggest segment was the one thing no tool did.
//
// No server, no datasource, no build. The page is a file: it opens offline, it attaches to
// a decision, and it diffs against the one from last month.
//
// Usage:
//   node scripts/run-report.mjs [--db <file>] [--out <file>] [--limit <n>]
//   node scripts/run-report.mjs --sessions <id,id,...>

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { REPO } from "./lib/paths.mjs";
import { FALLBACK_RATE_MODEL, price, rateFor } from "./lib/pricing.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(join(HERE, "report", "page.css"), "utf8");
const JS = readFileSync(join(HERE, "report", "page.js"), "utf8");

const args = process.argv.slice(2);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
};

const REDACT = args.includes("--redact");
const DB = value("db") || join(REPO, ".runs", "runs.sqlite");
const OUT = value("out") || join(REPO, ".runs", "report.html");
const LIMIT = Number(value("limit", "12"));
// Measured rather than assumed: every call of all twelve detailed runs weighs 1.2 MB of
// embedded JSON against 1.1 MB at a 400 cap, because only the three largest runs ever
// reached it. The cap bought nothing and made the timeline a 28% sample of the biggest run.
const CALLS_PER_RUN = Number(value("calls", "5000"));

const db = new DatabaseSync(DB);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);

const runs = all(`
  SELECT session_id, slug, title, arm, label, started_at, duration_ms, active_ms, busy_ms,
         coord_ms, stall_ms, stall_count, window_ms, window_start, window_end,
         host_turns, host_usd,
         agent_count, turn_count, call_count, error_count, usd, rate_known, has_hooks_log
  FROM runs WHERE turn_count > 0 ORDER BY started_at DESC`);

if (!runs.length) {
  console.error(`no runs in ${DB}. Run scripts/run-ingest.mjs --all first.`);
  process.exit(1);
}

// Default to the most expensive runs.
//
// Ranking by how many agents a run spawned looked reasonable and was badly wrong: on one
// project it returned ten review sessions and not one development session, because a
// review fans out to ten verification subagents while development is mostly a single agent
// grinding for two hours. Those single-agent runs were the expensive ones — $4.54 against
// $2.75 on average, 64% of the project's spend — and the ranking hid every one of them.
//
// Cost does not have a shape it prefers. It surfaces a wide fan-out and a long solo run
// alike, which is what a reader scanning for where the money goes actually wants.
const picked = value("sessions")
  ? value("sessions")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : [...runs]
      .sort((a, b) => b.usd - a.usd)
      .slice(0, LIMIT)
      .map((r) => r.session_id);

const detail = {};
// Models a figure was priced at the fallback rate for, with the sessions that used them.
const unpricedIn = new Map();

for (const id of picked) {
  // Percentiles and the duration histogram must see EVERY call, not the embedded sample:
  // a p95 computed over the 400 longest calls is not a p95 of anything.
  const durations = all(
    `SELECT charged_ms FROM calls WHERE session_id = ? AND charged_ms > 0
     ORDER BY charged_ms`,
    id,
  ).map((r) => r.charged_ms);

  const agents = all(
    `SELECT agent_id, role, description, model, turns, tool_turns, think_turns, calls,
              errors, ctx_first, ctx_last, ctx_max, out_tokens, usd, started_at, ended_at,
              active_ms, wait_ms, turns_in_window, calls_in_window, usd_in_window,
              outside_turns, outside_usd
       FROM agents WHERE session_id = ? AND turns > 0 ORDER BY started_at`,
    id,
  );
  // An agent's model is the first it ran; a later unpriced one shows as rate_known = 0
  // on the run without a name, which the page reports as such.
  const unpriced = [
    ...new Set(
      agents
        .map((a) => a.model)
        .filter((m) => m && m !== "<synthetic>" && !rateFor(m).known),
    ),
  ];
  for (const m of unpriced)
    unpricedIn.set(m, [...(unpricedIn.get(m) || []), id.slice(0, 8)]);

  detail[id] = {
    durations,
    agents,
    unpriced,
    activities: all(
      `SELECT activity, sum(wall_ms) wall_ms, sum(calls) calls, sum(errors) errors,
              sum(stalled) stalled
       FROM activities WHERE session_id = ? GROUP BY activity`,
      id,
    ),
    perAgentActivity: all(
      `SELECT agent_id, activity, wall_ms, calls FROM activities WHERE session_id = ?`,
      id,
    ),
    roles: all(
      `SELECT role, count(*) n, sum(turns_in_window) turns, sum(calls_in_window) calls,
              sum(usd_in_window) usd, sum(out_tokens) out_tokens, max(ctx_max) ctx_max
       FROM agents WHERE session_id = ? AND turns > 0 AND turns_in_window > 0
       GROUP BY role ORDER BY usd DESC`,
      id,
    ),
    tools: all(
      `SELECT tool_short, count(*) n, sum(charged_ms) ms, sum(is_error) err
       FROM calls WHERE session_id = ? GROUP BY tool_short ORDER BY ms DESC LIMIT 12`,
      id,
    ),
    files: all(
      `SELECT path, count(*) n FROM calls WHERE session_id = ? AND path IS NOT NULL
       GROUP BY path ORDER BY n DESC LIMIT 10`,
      id,
    ),
    turns: all(
      `SELECT agent_id, idx, at, activity, prev_activity, ctx, out_tokens, calls, wait_ms
       FROM turns WHERE session_id = ? ORDER BY agent_id, idx`,
      id,
    ),
    calls: all(
      `SELECT agent_id, turn_idx, tool_short, activity, summary, detail, at,
              duration_ms, charged_ms, stalled, is_error
       FROM calls WHERE session_id = ? ORDER BY charged_ms DESC LIMIT ?`,
      id,
      CALLS_PER_RUN,
    ),
    loops: all(
      `SELECT agent_id, kind, tool, count, wasted_ms, detail FROM loops
       WHERE session_id = ? ORDER BY wasted_ms DESC, count DESC LIMIT 12`,
      id,
    ),
    waitAfter: all(
      `SELECT prev_activity prev, count(*) turns, sum(min(wait_ms, 300000)) wait_ms,
              cast(avg(out_tokens) as int) avg_out
       FROM turns WHERE session_id = ? AND wait_ms > 0 AND prev_activity IS NOT NULL
         AND agent_id <> 'main'
       GROUP BY prev_activity ORDER BY wait_ms DESC`,
      id,
    ),
    // The preamble is measured, not reconstructed: ctx_first is the billed context of an
    // agent's very first turn, which is everything it was handed before it did anything.
    // The attachment breakdown is the right way to see WHAT is in it, but a wrong way to
    // size it: Claude Code only started emitting prompt_snapshot and instructions partway
    // through this archive, and on a session that predates them the same sum reported 2%
    // where the measured figure is 19%.
    preamble: all(
      `SELECT agent_id, role, turns_in_window turns, ctx_first tokens,
              (SELECT sum(c.bytes) FROM context c
                WHERE c.session_id = agents.session_id AND c.agent_id = agents.agent_id
                  AND c.component IN ('tools','skills','instructions','system')) bytes
       FROM agents WHERE session_id = ? AND turns_in_window > 0`,
      id,
    ),
    // How many agents the composition is actually known for. Without it a panel drawn from
    // one component out of seven looks like a finding.
    contextCoverage: one(
      `SELECT (SELECT count(DISTINCT agent_id) FROM context
                WHERE session_id = ? AND component = 'tools') known,
              (SELECT count(*) FROM agents
                WHERE session_id = ? AND turns_in_window > 0) total`,
      id,
      id,
    ),
    tokens: one(
      `SELECT sum(cache_read + in_tokens + cache_write) reread, sum(out_tokens) out,
              count(*) turns
       FROM turns WHERE session_id = ?`,
      id,
    ),
    // Tokens split the way they are actually billed, each model priced at its own rate.
    // The four kinds are not interchangeable: a cache read costs a tenth of fresh input,
    // and an hour-long cache write costs twice it.
    tokenKinds: (() => {
      // Scoped to the run window like every other cost on the page: over the whole session
      // this summed to $37 where the run costs $26, which is the host session's own work.
      const r = one(
        `SELECT window_start, window_end FROM runs WHERE session_id = ?`,
        id,
      );
      const rows = all(
        `SELECT model, sum(in_tokens) inp, sum(cache_read) cr, sum(cache_write) cw,
                sum(out_tokens) out
         FROM turns t WHERE t.session_id = ? AND t.model <> ''
           AND (? IS NULL OR (t.at >= ? AND t.at <= ?))
         GROUP BY t.model`,
        id,
        r.window_start,
        r.window_start,
        r.window_end,
      );
      const acc = {
        input: { tokens: 0, usd: 0 },
        cacheRead: { tokens: 0, usd: 0 },
        cacheWrite: { tokens: 0, usd: 0 },
        output: { tokens: 0, usd: 0 },
      };
      for (const r of rows) {
        // cw5m, because the transcript does not split the two cache TTLs per model here;
        // the 1h rate applies to one agent only and is priced at the turn level upstream.
        const u = price({
          in: r.inp,
          cacheRead: r.cr,
          cw5m: r.cw,
          out: r.out,
          model: r.model,
        });
        acc.input.tokens += r.inp;
        acc.input.usd += u.input;
        acc.cacheRead.tokens += r.cr;
        acc.cacheRead.usd += u.cacheRead;
        acc.cacheWrite.tokens += r.cw;
        acc.cacheWrite.usd += u.cacheWrite;
        acc.output.tokens += r.out;
        acc.output.usd += u.output;
      }
      return acc;
    })(),
    // Reading is what an agent is for, so counting reads says nothing. Reading the SAME
    // file twice in the same agent does: the first read fell out of the context, and the
    // second one is paid twice over, once for the call and once for the tokens it puts
    // back.
    rereads: one(
      `SELECT (SELECT count(*) FROM calls
                WHERE session_id = ? AND tool_short = 'Read' AND path IS NOT NULL) total,
              (SELECT coalesce(sum(n - 1), 0) FROM (
                 SELECT count(*) n FROM calls
                 WHERE session_id = ? AND tool_short = 'Read' AND path IS NOT NULL
                 GROUP BY agent_id, path HAVING n > 1)) again`,
      id,
      id,
    ),
    // What is inside each part of a fresh context, PER ROLE. Roles are not handed the same
    // thing at all: on one run the main thread carries 14 tool definitions for 124 KB while
    // the planner carries 6 for 12 KB. Grouping by component alone made every bar open onto
    // the same union, which contradicted the bar that had just been clicked.
    contextItems: all(
      `SELECT a.role, c.component, max(c.bytes) bytes, max(c.detail) detail
       FROM context c JOIN agents a USING (session_id, agent_id)
       WHERE c.session_id = ? AND a.turns_in_window > 0
         AND (c.component LIKE 'tool:%' OR c.component LIKE 'skill:%'
              OR c.component LIKE 'file:%')
       GROUP BY a.role, c.component ORDER BY bytes DESC`,
      id,
    ),
    errorsByTool: all(
      `SELECT tool_short, count(*) n, sum(is_error) err FROM calls
       WHERE session_id = ? GROUP BY tool_short HAVING err > 0
       ORDER BY err DESC LIMIT 6`,
      id,
    ),
    stalls: all(
      `SELECT at, ms FROM stalls WHERE session_id = ? ORDER BY ms DESC LIMIT 8`,
      id,
    ).map((g) => ({
      ...g,
      // What bracketed the silence. Without these a stall is a duration with no cause, and
      // the page would be telling the reader to go and grep the transcript themselves.
      before: one(
        `SELECT c.tool_short, c.activity, c.detail, c.at, a.role
         FROM calls c JOIN agents a USING (session_id, agent_id)
         WHERE c.session_id = ? AND c.at <= ? ORDER BY c.at DESC LIMIT 1`,
        id,
        g.at,
      ),
      after: one(
        `SELECT c.tool_short, c.activity, c.detail, c.at, a.role
         FROM calls c JOIN agents a USING (session_id, agent_id)
         WHERE c.session_id = ? AND c.at >= ? ORDER BY c.at ASC LIMIT 1`,
        id,
        g.at + g.ms,
      ),
      // hooks.log is the only place a SubagentStop leaves a trace, so it is the only way a
      // validation chain running inside the gap can be told from nobody being there.
      hooks: all(
        `SELECT at, hook, message FROM hook_events
         WHERE session_id = ? AND at >= ? AND at <= ? ORDER BY at LIMIT 12`,
        id,
        g.at,
        g.at + g.ms,
      ),
    })),
    hookTotal: one(
      `SELECT sum(runs) runs, sum(ms) ms FROM hooks WHERE session_id = ? AND runs > 0`,
      id,
    ),
    hooks: all(
      `SELECT hook, event, sum(runs) runs, sum(ms) ms, sum(failures) failures,
              sum(blocks) blocks
       FROM hooks WHERE session_id = ? GROUP BY hook, event
       HAVING runs > 0 OR blocks > 0 ORDER BY failures DESC, runs DESC LIMIT 10`,
      id,
    ),
    // What every agent was handed before it read a word of its task.
    context: all(
      `SELECT c.agent_id, a.role, c.component, c.bytes, c.detail
       FROM context c JOIN agents a USING (session_id, agent_id)
       WHERE c.session_id = ? AND c.component NOT LIKE 'file:%'`,
      id,
    ),
    contextFiles: all(
      `SELECT detail, max(bytes) bytes, count(*) agents FROM context
       WHERE session_id = ? AND component LIKE 'file:%'
       GROUP BY detail ORDER BY bytes DESC LIMIT 8`,
      id,
    ),
  };
}

const totals = one(`
  SELECT count(*) runs, sum(active_ms) active_ms, sum(usd) usd, sum(has_hooks_log) with_hooks
  FROM runs WHERE turn_count > 0`);

/**
 * Strip everything that quotes the session, keeping everything that counts it.
 *
 * The page embeds real data: every shell command in full, absolute paths, agent
 * descriptions, the names of the injected instruction files. That is what makes a bar
 * worth clicking, and it is also what makes the page unfit for a public repository or an
 * issue. Redacting removes the QUOTED text and touches no number, so every tile, every
 * chart and every share is identical with the flag and without it — only the drill-downs
 * lose their labels.
 *
 * Deliberately a denylist of the fields that carry free text, not an allowlist of safe
 * ones: a new field is far more likely to be another number than another command, and a
 * missed number would be a silent hole in the analysis where a missed string is visible on
 * the page. The test asserts the absence of paths and commands over the whole output.
 */
function redact(payload) {
  const cut = (row, ...fields) => {
    for (const f of fields) if (row && row[f] != null) row[f] = null;
  };
  // A project path names a client. Its last segment is enough to tell two runs apart.
  const shortSlug = (slug) =>
    String(slug || "")
      .split("-")
      .pop() || "project";

  for (const r of payload.runs) {
    r.slug = shortSlug(r.slug);
    cut(r, "label", "title");
  }
  for (const d of Object.values(payload.detail)) {
    for (const c of d.calls) cut(c, "detail", "path", "summary");
    for (const a of d.agents) cut(a, "description");
    for (const l of d.loops) cut(l, "detail");
    for (const f of d.files) cut(f, "path");
    for (const c of d.contextFiles) cut(c, "detail");
    for (const c of d.contextItems)
      if (c.component.startsWith("file:")) {
        c.component = "file:" + (c.component.split("/").pop() || "?");
        cut(c, "detail");
      }
    for (const h of d.hooks) cut(h, "message");
    for (const g of d.stalls) {
      cut(g.before, "detail");
      cut(g.after, "detail");
      for (const h of g.hooks) cut(h, "message");
    }
  }
  return payload;
}

const payload = {
  generatedAt: new Date().toISOString(),
  totals,
  runs,
  picked,
  detail,
  redacted: REDACT,
};

// Every `<` escaped, not just the `</script` sequence.
//
// Inside a script element the HTML parser only leaves on `</script`, so escaping that
// looked sufficient. It is not: `<!--` puts the parser into its escaped state, a following
// `<script` into its double-escaped state, and in that state the first `</script>` no
// longer closes the element. The payload is transcripts, which carry shell commands that
// write HTML, so both sequences occur — ten calls in this archive contain `<script`.
//
// `\u003c` is the same character to JSON.parse and nothing at all to the HTML parser, so
// the payload becomes inert whatever it holds. It costs five bytes per `<`, which on this
// archive is a fraction of a percent.
const json = JSON.stringify(REDACT ? redact(payload) : payload).replace(
  /</g,
  "\\u003c",
);

const html = `<title>Session stats</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>${CSS}</style>

<div id="tip"></div>

<div class="bar"><div class="wrap">
  <h1 id="h1">Session stats</h1>
  <select id="pick" aria-label="Run"></select>
  <span class="sub" id="runsub"></span>
  <span class="tag" id="redacted" hidden></span>
  <span class="tag bad" id="unpriced" hidden></span>
  <span class="langs" id="langs" role="group" aria-label="Language">
    <button type="button" data-lang="0">EN</button><button type="button" data-lang="1">FR</button>
  </span>
</div></div>

<div class="wrap">
  <div id="boom" hidden></div>
  <div class="grid" id="grid"></div>
</div>

<script type="application/json" id="data">${json}</script>
<script>
${JS}
</script>
`;

const inlineScript = html.match(/<script>([\s\S]*)<\/script>\s*$/);
if (!inlineScript) {
  console.error("the generated page has no inline script: the template broke");
  process.exit(1);
}
try {
  new Function(inlineScript[1]);
} catch (err) {
  console.error(
    `the generated page's script does not parse: ${err.message}\n` +
      "A backtick, a double quote or a ${ in the page's prose breaks the template literal " +
      "that holds it. Use single quotes in tooltip text.",
  );
  process.exit(1);
}

writeFileSync(OUT, html);
const kb = Math.round(Buffer.byteLength(html) / 1024);
console.log(
  `${OUT}  (${kb}KB, ${runs.length} runs, ${picked.length} detailed)`,
);
// The figures above are wrong for these models, by however far their real rate is from the
// fallback's. Said on its own line so a caller can relay it.
for (const [model, sessions] of unpricedIn)
  console.log(
    `unpriced: ${model} (sessions ${sessions.join(", ")}) priced at the ` +
      `${FALLBACK_RATE_MODEL} rate; add it to scripts/lib/pricing.mjs`,
  );
