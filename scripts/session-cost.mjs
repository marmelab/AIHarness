#!/usr/bin/env node
// Token cost of one harness session: per-agent turns, tool calls, and cache reads.
//
// The counterpart to session-timeline.mjs, which measures WALL CLOCK and says so: cost and
// time do not distribute the same way. A run whose longest pole is one developer can still
// spend most of its money somewhere else entirely.
//
// What it answers: which role the money went to, and why. The unit is the TURN, because
// every turn re-reads the agent's whole accumulated context. On one profiled run, input was
// 99.9% of all tokens and 97% of the bill; its most expensive developer went from 16K to
// 134K tokens of context across 65 turns, so its last turns cost eight times its first.
//
// A TURN IS ONE API RESPONSE, NOT ONE TRANSCRIPT ENTRY. The transcript writes one entry per
// content block, each repeating the SAME usage object, so a response that thinks and then
// calls two tools appears as three entries carrying identical cache_read figures. Summing
// per entry inflated one run's turns 1.85x, its cache reads 76%, and its output 8.8x, and
// made 30% of turns look like they produced nothing when they were the thinking block of a
// response that did call a tool. Group by message.id, take usage ONCE per id, and count
// tool_use across that id's entries.
// Two numbers follow from that and neither is visible in a usage total:
//
//   - turns with NO tool call. Deliberation and narration, paid at full context price.
//     One run was 40% such turns.
//   - tool calls per turn. An agent that batches reads pays for fewer context re-reads
//     than one that serialises them.
//
// Reads transcripts only; writes nothing. Cache-read tokens are reported raw rather than
// priced: rates change, and the ratios are what the tuning decisions rest on.
//
// CLI only: this module parses argv and exits at import time, so it is exercised through
// spawnSync (scripts/test/session-cost.test.mjs), never imported. Same reason the hooks'
// parsers live in hooks/lib/.
//
// Usage: node scripts/session-cost.mjs <session-id> [--project <slug>] [--by-role]
//   <slug> defaults to the current repo's transcript directory name under
//   ~/.claude/projects.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { REPO, CONFIG_DIR } from "../hooks/lib/paths.mjs";

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--")) || "";
const byRole = args.includes("--by-role");
const slugFlag = args.indexOf("--project");
const slug =
  slugFlag !== -1 && args[slugFlag + 1]
    ? args[slugFlag + 1]
    : REPO.replace(/\//g, "-");

if (!sessionId) {
  console.error(
    "usage: node scripts/session-cost.mjs <session-id> [--project <slug>] [--by-role]",
  );
  process.exit(1);
}

const projectDir = join(CONFIG_DIR, "projects", slug);
if (!existsSync(join(projectDir, `${sessionId}.jsonl`))) {
  console.error(`no transcript at ${join(projectDir, `${sessionId}.jsonl`)}`);
  process.exit(1);
}

/**
 * Tally one transcript's assistant turns.
 *
 * Counts a turn per assistant message that carries a usage block, so a message the runtime
 * did not bill (and mid-turn snapshots without usage) never inflates the count.
 *
 * @param {string} file
 * @returns {{turns: number, toolTurns: number, toolCalls: number, out: number, cacheRead: number, cacheWrite: number, model: string, ctxFirst: number, ctxLast: number}}
 */
function tally(file) {
  const t = {
    turns: 0,
    toolTurns: 0,
    toolCalls: 0,
    out: 0,
    cacheRead: 0,
    cacheWrite: 0,
    model: "",
    ctxFirst: 0,
    ctxLast: 0,
  };
  let body = "";
  try {
    body = readFileSync(file, "utf8");
  } catch {
    return t;
  }
  // One record per API response, keyed by message.id. An entry with no id is its own
  // response (older transcripts, and the runtime's own synthetic entries).
  const byId = new Map();
  let anon = 0;
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const usage = event.type === "assistant" && event.message?.usage;
    if (!usage) continue;
    const id = event.message.id || `anon-${anon++}`;
    if (!byId.has(id)) byId.set(id, { usage, calls: 0, model: event.message.model });
    const rec = byId.get(id);
    rec.calls += (event.message.content || []).filter(
      (c) => c.type === "tool_use",
    ).length;
    if (!rec.model && event.message.model) rec.model = event.message.model;
  }
  for (const rec of byId.values()) {
    const u = rec.usage;
    t.turns++;
    t.out += u.output_tokens || 0;
    t.cacheRead += u.cache_read_input_tokens || 0;
    t.cacheWrite += u.cache_creation_input_tokens || 0;
    const ctx =
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0) +
      (u.input_tokens || 0);
    if (!t.ctxFirst) t.ctxFirst = ctx;
    t.ctxLast = ctx;
    t.model = (rec.model || t.model)
      .replace(/^claude-/, "")
      .replace(/-\d{8}$/, "");
    if (rec.calls) {
      t.toolTurns++;
      t.toolCalls += rec.calls;
    }
  }
  return t;
}

const rows = [];
const subagents = join(projectDir, sessionId, "subagents");
if (existsSync(subagents)) {
  for (const f of readdirSync(subagents).filter((x) =>
    /^agent-.+\.jsonl$/.test(x),
  )) {
    const id = basename(f, ".jsonl").replace(/^agent-/, "");
    let meta = {};
    try {
      meta = JSON.parse(
        readFileSync(join(subagents, `agent-${id}.meta.json`), "utf8"),
      );
    } catch {
      // a transcript with no meta still has a tally worth showing
    }
    const t = tally(join(subagents, f));
    if (!t.turns) continue;
    rows.push({
      id: id.slice(0, 9),
      role: (meta.agentType || "?").replace(/^[\w.-]+:/, ""),
      desc: (meta.description || "").slice(0, 30),
      ...t,
    });
  }
}

if (!rows.length) {
  console.error(
    `no subagent transcripts under ${subagents}\n` +
      "(a session that dispatched no agent has no per-agent cost to report)",
  );
  process.exit(1);
}

rows.sort((a, b) => b.cacheRead - a.cacheRead);

const M = (n) => (n / 1e6).toFixed(2) + "M";
const K = (n) => Math.round(n / 1000) + "K";
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

const tot = rows.reduce(
  (a, r) => ({
    turns: a.turns + r.turns,
    toolTurns: a.toolTurns + r.toolTurns,
    toolCalls: a.toolCalls + r.toolCalls,
    out: a.out + r.out,
    cacheRead: a.cacheRead + r.cacheRead,
    cacheWrite: a.cacheWrite + r.cacheWrite,
  }),
  { turns: 0, toolTurns: 0, toolCalls: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
);

console.log(`session ${sessionId}`);
console.log(
  `${rows.length} agents, ${tot.turns} turns, ${M(tot.cacheRead)} cache-read, ${K(tot.out)} output\n`,
);

if (byRole) {
  const roles = new Map();
  for (const r of rows) {
    const a = roles.get(r.role) || {
      n: 0,
      turns: 0,
      toolTurns: 0,
      cacheRead: 0,
      out: 0,
    };
    a.n++;
    a.turns += r.turns;
    a.toolTurns += r.toolTurns;
    a.cacheRead += r.cacheRead;
    a.out += r.out;
    roles.set(r.role, a);
  }
  console.log("role                 n  turns  no-tool  cache-read   share");
  for (const [role, a] of [...roles].sort(
    (x, y) => y[1].cacheRead - x[1].cacheRead,
  )) {
    console.log(
      `${role.padEnd(20)} ${String(a.n).padStart(1)}  ${String(a.turns).padStart(5)}  ${String(pct(a.turns - a.toolTurns, a.turns) + "%").padStart(7)}  ${M(a.cacheRead).padStart(10)}  ${String(pct(a.cacheRead, tot.cacheRead) + "%").padStart(5)}`,
    );
  }
} else {
  console.log(
    "agent      role              model     turns  no-tool  calls/t  cache-read  ctx first->last",
  );
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(10)} ${r.role.padEnd(17)} ${r.model.padEnd(9)} ${String(r.turns).padStart(5)}  ${String(pct(r.turns - r.toolTurns, r.turns) + "%").padStart(7)}  ${(r.toolTurns ? (r.toolCalls / r.toolTurns).toFixed(1) : "0.0").padStart(7)}  ${M(r.cacheRead).padStart(10)}  ${K(r.ctxFirst)}->${K(r.ctxLast)}`,
    );
  }
}

const noTool = tot.turns - tot.toolTurns;
console.log(
  `\nturns with no tool call: ${noTool}/${tot.turns} (${pct(noTool, tot.turns)}%)`,
);
console.log(
  `tool calls per tool-using turn: ${(tot.toolCalls / (tot.toolTurns || 1)).toFixed(1)}` +
    ` (1.0 means no response ever called two tools at once)`,
);
const top = rows[0];
console.log(
  `largest consumer: ${top.role} ${top.id} at ${pct(top.cacheRead, tot.cacheRead)}% of cache reads`,
);
