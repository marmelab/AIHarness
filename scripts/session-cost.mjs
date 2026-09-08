#!/usr/bin/env node
// Token cost of one harness session: per-agent turns, tokens, dollars, cache expiries.
//
// The counterpart to session-timeline.mjs, which measures WALL CLOCK: cost and time do not
// distribute the same way. A run whose longest pole is one developer can still spend most
// of its money elsewhere.
//
// The unit is the TURN, because every turn re-reads the agent's whole accumulated context.
// Four things no usage total shows:
//
//   - turns with NO tool call: deliberation, paid at full context price.
//   - tool calls per turn: batching reads costs fewer context re-reads than serialising.
//   - CACHE EXPIRIES: a 5-minute cache dies during a long hook and the next turn re-writes
//     the context at 1.25x input instead of reading it at 0.1x. 12x, for waiting.
//   - REVIEW DISPATCHES BY KIND: a re-review costs as much as a review, and a retry caused
//     by a harness bug costs the same again and buys nothing.
//
// The arithmetic is in scripts/lib/session-cost.mjs and unit-tested there. This file parses
// argv and formats, so it is exercised through spawnSync, never imported.
//
// Usage: node scripts/session-cost.mjs <session-id> [--project <slug>] [--by-role] [--json]
//   <slug> defaults to the current repo's transcript directory name under
//   ~/.claude/projects.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { REPO, CONFIG_DIR } from "../hooks/lib/paths.mjs";
import {
  classifyReviewDispatch,
  price,
  sumTallies,
  tallyTranscript,
} from "./lib/session-cost.mjs";

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--")) || "";
const byRole = args.includes("--by-role");
const asJson = args.includes("--json");
const slugFlag = args.indexOf("--project");
const slug =
  slugFlag !== -1 && args[slugFlag + 1]
    ? args[slugFlag + 1]
    : REPO.replace(/\//g, "-");

if (!sessionId) {
  console.error(
    "usage: node scripts/session-cost.mjs <session-id> [--project <slug>] [--by-role] [--json]",
  );
  process.exit(1);
}

const projectDir = join(CONFIG_DIR, "projects", slug);
const mainTranscript = join(projectDir, `${sessionId}.jsonl`);
if (!existsSync(mainTranscript)) {
  console.error(`no transcript at ${mainTranscript}`);
  process.exit(1);
}

const read = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

const withPrice = (t) => ({ ...t, usd: price(t) });

// A real payer, but not an agent: kept out of the agent totals rather than averaged into
// a role.
const main = withPrice(tallyTranscript(read(mainTranscript)));

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
    const t = tallyTranscript(read(join(subagents, f)));
    if (!t.turns) continue;
    const role = (meta.agentType || "?").replace(/^[\w.-]+:/, "");
    const description = meta.description || "";
    rows.push({
      id: id.slice(0, 9),
      role,
      desc: description.slice(0, 30),
      reviewKind:
        role === "quality-reviewer"
          ? classifyReviewDispatch(description)
          : null,
      ...withPrice(t),
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

rows.sort((a, b) => b.usd.total - a.usd.total);

const tot = sumTallies(rows);
const M = (n) => (n / 1e6).toFixed(2) + "M";
const K = (n) => Math.round(n / 1000) + "K";
const $ = (n) => "$" + n.toFixed(2);
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);
const cw = (r) => (r.cw5m || 0) + (r.cw1h || 0);

const reviewKinds = new Map();
for (const r of rows) {
  if (!r.reviewKind) continue;
  const k = reviewKinds.get(r.reviewKind) || { n: 0, turns: 0, usd: 0 };
  k.n++;
  k.turns += r.turns;
  k.usd += r.usd.total;
  reviewKinds.set(r.reviewKind, k);
}

if (asJson) {
  console.log(
    JSON.stringify({
      session: sessionId,
      project: slug,
      main,
      agents: rows,
      totals: tot,
      reviewKinds: Object.fromEntries(reviewKinds),
    }),
  );
  process.exit(0);
}

const unpriced = [
  ...new Set(
    rows
      .concat(main.turns ? [main] : [])
      .filter((r) => !r.usd.rateKnown)
      .flatMap((r) => r.models),
  ),
];

console.log(`session ${sessionId}`);
console.log(
  `${rows.length} agents, ${tot.turns} turns, ${M(tot.cacheRead)} cache-read, ` +
    `${M(tot.cw5m + tot.cw1h)} cache-write, ${K(tot.out)} output, ${K(tot.in)} fresh input`,
);
console.log(
  `subagents ${$(tot.usd)} = cache-read ${$(tot.usdCacheRead)} (${pct(tot.usdCacheRead, tot.usd)}%)` +
    ` + cache-write ${$(tot.usdCacheWrite)} (${pct(tot.usdCacheWrite, tot.usd)}%)` +
    ` + output ${$(tot.usdOutput)} (${pct(tot.usdOutput, tot.usd)}%)` +
    ` + fresh input ${$(tot.usdInput)}`,
);
if (main.turns)
  console.log(
    `main thread ${$(main.usd.total)} (${main.turns} turns, not counted above)` +
      ` | session total ${$(tot.usd + main.usd.total)}`,
  );
if (unpriced.length)
  console.log(
    `WARNING no rate for ${unpriced.join(", ")}: priced at the sonnet-5 rate, so the totals are a floor`,
  );
if (tot.usageMismatches)
  console.log(
    `WARNING ${tot.usageMismatches} responses whose entries disagreed on input-side usage: totals are suspect`,
  );
console.log("");

if (byRole) {
  const roles = new Map();
  for (const r of rows) {
    const a = roles.get(r.role) || {
      n: 0,
      turns: 0,
      toolTurns: 0,
      cacheRead: 0,
      out: 0,
      usd: 0,
      expiries: 0,
      models: new Set(),
    };
    a.n++;
    a.turns += r.turns;
    a.toolTurns += r.toolTurns;
    a.cacheRead += r.cacheRead;
    a.out += r.out;
    a.usd += r.usd.total;
    a.expiries += r.expiries.count;
    for (const m of r.models) a.models.add(m);
    roles.set(r.role, a);
  }
  console.log(
    "role                 n  turns  no-tool  cache-read   share    exp        $     $%  models",
  );
  for (const [role, a] of [...roles].sort((x, y) => y[1].usd - x[1].usd)) {
    console.log(
      `${role.padEnd(20)} ${String(a.n).padStart(1)}  ${String(a.turns).padStart(5)}  ` +
        `${String(pct(a.turns - a.toolTurns, a.turns) + "%").padStart(7)}  ${M(a.cacheRead).padStart(10)}  ` +
        `${String(pct(a.cacheRead, tot.cacheRead) + "%").padStart(5)}  ${String(a.expiries).padStart(3)}  ` +
        `${$(a.usd).padStart(7)}  ${String(pct(a.usd, tot.usd) + "%").padStart(5)}  ${[...a.models].join(",")}`,
    );
  }
} else {
  console.log(
    "agent      role              model     turns  no-tool  calls/t  cache-read  cache-write  output  exp        $  ctx first->last",
  );
  for (const r of rows) {
    console.log(
      `${r.id.padEnd(10)} ${r.role.padEnd(17)} ${r.model.padEnd(9)} ${String(r.turns).padStart(5)}  ` +
        `${String(pct(r.turns - r.toolTurns, r.turns) + "%").padStart(7)}  ` +
        `${(r.toolTurns ? (r.toolCalls / r.toolTurns).toFixed(1) : "0.0").padStart(7)}  ` +
        `${M(r.cacheRead).padStart(10)}  ${K(cw(r)).padStart(11)}  ${K(r.out).padStart(6)}  ` +
        `${String(r.expiries.count).padStart(3)}  ${$(r.usd.total).padStart(7)}  ${K(r.ctxFirst)}->${K(r.ctxLast)}`,
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
console.log(
  `cache expiries: ${tot.expiries} turns re-wrote ${K(tot.expiredTokens)} tokens after a gap > 5 min` +
    ` (${pct(tot.expiredTokens, tot.cw5m + tot.cw1h)}% of all cache write)`,
);

if (reviewKinds.size) {
  console.log("\nreview dispatches by kind:");
  for (const [kind, k] of [...reviewKinds].sort((a, b) => b[1].usd - a[1].usd))
    console.log(
      `  ${kind.padEnd(20)} ${String(k.n).padStart(2)} dispatches  ${String(k.turns).padStart(4)} turns  ${$(k.usd).padStart(7)}`,
    );
}

const top = rows[0];
console.log(
  `\nlargest consumer: ${top.role} ${top.id} at ${pct(top.usd.total, tot.usd)}% of the subagent bill`,
);
