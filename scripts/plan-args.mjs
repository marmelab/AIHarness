#!/usr/bin/env node
// Assemble the args the harness-execute-plan workflow runs on.
//
//   node scripts/plan-args.mjs
//   node scripts/plan-args.mjs --pending      # skip tickets already merged
//
// A workflow script has no filesystem and no Node API, so everything it needs about the
// session arrives as one JSON value. This reads the same TASK-*.json the orchestrator
// loads in EXECUTE-PLAN, the same topology the hooks compute, and the same review tiers
// harness.config.json declares, and prints the object to hand to the workflow.
//
// Tickets are passed through with only the fields the script reads — id, dependencies,
// parallel_safe, tier. A whole ticket body would put the plan back into a context window,
// which is the thing the workflow exists to avoid: the agents read their own ticket file
// from TICKET_FILE.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createHookContext } from "../hooks/lib/context.mjs";
import { loadConfig } from "../hooks/lib/config.mjs";
import { readTickets } from "../hooks/lib/tickets.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);

const ctx = createHookContext(
  { session_id: process.env.CLAUDE_CODE_SESSION_ID || "" },
  "plan-args",
);

let tickets;
try {
  tickets = readTickets(ctx);
} catch (e) {
  console.error(`plan-args: ${e.message}`);
  process.exit(1);
}

if (!tickets.length) {
  console.error(
    `plan-args: no TASK-*.json under ${ctx.ticketsDir}\n` +
      `  Run the planning phase first: the workflow executes an approved plan, it does\n` +
      `  not make one.`,
  );
  process.exit(1);
}

const unreadable = tickets.filter((t) => t.status === "unreadable").length;
if (unreadable) {
  // Silently dropping a ticket would run a partial plan and report success.
  console.error(`plan-args: ${unreadable} ticket file(s) could not be parsed`);
  process.exit(1);
}

const wanted = flag("pending")
  ? tickets.filter((t) => t.status !== "merged")
  : tickets;

if (!wanted.length) {
  console.error(
    "plan-args: every ticket is already merged, nothing to execute",
  );
  process.exit(1);
}

const config = loadConfig();
const tiers = (config && config.review && config.review.tiers) || {};
const reviewModel = {};
for (const [tier, cfg] of Object.entries(tiers))
  if (cfg && cfg.model) reviewModel[tier] = cfg.model;

const payload = {
  sessionShort: ctx.sessionShort,
  worktreeBase: ctx.worktreeBase,
  ticketsDir: ctx.ticketsDir,
  reviewModel,
  // MAX_RETRIES is 2 in the orchestrator, three developer attempts in all. Read from
  // config so a project can lower it, with the orchestrator's own value as the default.
  maxRetries: (config && config.review && config.review.maxRetries) ?? 2,
  tickets: wanted.map((t) => ({
    id: t.id,
    dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
    // Only `false` is meaningful: a missing field means the planner said nothing, which
    // is the parallel-safe default.
    parallel_safe: t.parallel_safe === false ? false : true,
    tier: t.tier || t.review_tier || "normal",
  })),
};

for (const t of payload.tickets)
  if (!/^TASK-\d+$/.test(String(t.id))) {
    console.error(
      `plan-args: ticket with no usable id: ${JSON.stringify(t.id)}`,
    );
    process.exit(1);
  }

console.log(JSON.stringify(payload, null, 2));
