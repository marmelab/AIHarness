#!/usr/bin/env node
// PreToolUse(Agent): set the per-ticket review model from the ticket's difficulty tier:
// the planner's scorecard, the real diff, the schema sensitivity, the stored tier, the
// highest wins, by rewriting the dispatch rather than asking the orchestrator to
// remember the rule.
//
// Two directions, and they are NOT symmetric:
//
//   ordinary ticket   -> SET model "sonnet"
//   schema-sensitive  -> REMOVE model, so the agent file's `opus` applies
//
// Removing rather than naming `opus` is load-bearing: a runtime that ignores `model` then
// leaves the reviewer on its declared default, so the failure mode of the optimisation is
// spending too much, never reviewing too weakly. Fail-open goes the same way: anything
// unreadable leaves the dispatch as dispatched, which is usually opus.

import { readFileSync, writeFileSync } from "node:fs";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { isQualityReviewer } from "./lib/teams.mjs";
import { loadConfig, reviewTierModel } from "./lib/config.mjs";
import {
  TIERS,
  diffStats,
  maxTier,
  tierFromDiff,
  tierFromScorecard,
} from "./lib/tier.mjs";

// A miss in these has nothing downstream to catch it, so they are never downgraded.
const WHOLE_FEATURE_MODE =
  /^MODE:\s*(feature-review|feature-smoke|migration-review)/m;

/** Does this ticket's blast radius reach the database? */
export function isSchemaSensitive(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  if (ticket.schema_sensitive === true) return true;
  const files = Array.isArray(ticket.files_to_modify)
    ? ticket.files_to_modify
    : [];
  return files.some((f) => /(^|\/)supabase\//.test(String(f)));
}

const TIER_LINE = /^REVIEW_TIER:.*$/m;

function withTierLine(prompt, tier) {
  const line = `REVIEW_TIER: ${tier}`;
  return TIER_LINE.test(prompt)
    ? prompt.replace(TIER_LINE, line)
    : `${prompt}\n${line}`;
}

export function check(input, ctx) {
  const d = parseDispatch(input);
  if (!isQualityReviewer(d.subagentType)) return;

  const prompt = String(input?.tool_input?.prompt ?? "");
  if (WHOLE_FEATURE_MODE.test(prompt))
    return ctx.allow("whole-feature or migration review: never downgraded");

  // Inputs, each optional: a missing one is logged as such and simply does not lower the tier.
  let ticket = null;
  if (d.ticketFile) {
    try {
      ticket = JSON.parse(readFileSync(d.ticketFile, "utf8"));
    } catch {
      return ctx.allow(
        `ticket unreadable (${d.ticketFile}): left as dispatched, which keeps the stronger model`,
      );
    }
    if (!ticket || typeof ticket !== "object")
      return ctx.allow("ticket is not an object: left as dispatched");
  }

  const fromScorecard = tierFromScorecard(ticket?.scorecard);
  let stats = null;
  const m = d.branchName.match(/^([^/]+)\//);
  if (d.worktreePath && m) stats = diffStats(d.worktreePath, `session/${m[1]}`);
  // An empty committed diff is not a signal: nothing has landed since the session branch,
  // so it must never read as "small change" and pull the tier down toward trivial.
  const fromDiff = stats && stats.files > 0 ? tierFromDiff(stats) : null;
  const diffLabel =
    stats === null ? "none" : stats.files === 0 ? "empty" : fromDiff;
  const schema = ticket ? isSchemaSensitive(ticket) === true : false;
  const stored = ticket && TIERS.includes(ticket.tier) ? ticket.tier : null;
  const tier = maxTier(fromScorecard, fromDiff, schema ? "hard" : null, stored);

  if (ticket && ticket.tier !== tier) {
    try {
      writeFileSync(
        d.ticketFile,
        JSON.stringify({ ...ticket, tier }, null, 2) + "\n",
      );
    } catch {
      // the ticket is a convenience copy of the decision; the dispatch below is the decision
    }
  }

  let model;
  try {
    model = reviewTierModel(loadConfig(), tier);
  } catch {
    model = "default"; // unreadable config: the expensive direction
  }
  const asked = input?.tool_input?.model;
  const detail =
    `${d.taskId || "?"} tier=${tier} (scorecard=${fromScorecard ?? "none"} diff=${diffLabel} ` +
    `schema=${schema ? "yes" : "no"} stored=${stored ?? "none"}) model=${model}`;
  const patch = { prompt: withTierLine(prompt, tier) };
  if (model === "default") {
    if (asked !== undefined) patch.model = undefined;
  } else if (asked !== model) {
    patch.model = model;
  }
  return ctx.rewriteInput(patch, { log: detail });
}

runStandalone(import.meta.url, "route-review-model", check);
