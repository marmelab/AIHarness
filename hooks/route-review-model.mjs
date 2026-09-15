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
import { sessionBranch } from "./lib/topology.mjs";
import { loadConfig, reviewTierModel } from "./lib/config.mjs";
import {
  TIERS,
  diffStats,
  maxTier,
  tierFromDiff,
  tierFromScorecard,
} from "./lib/tier.mjs";

// A miss in these has nothing downstream to catch it, so they are never downgraded, and
// `review` (the standalone /harness-review pass) has no ticket and no worktree to tier
// from at all.
const UNTOUCHED_MODE =
  /^MODE:\s*(feature-review|feature-smoke|migration-review|review)\s*$/m;

/** Does this ticket's blast radius reach the database? */
export function isSchemaSensitive(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  if (ticket.schema_sensitive === true) return true;
  const files = Array.isArray(ticket.files_to_modify)
    ? ticket.files_to_modify
    : [];
  return files.some((f) => /(^|\/)supabase\//.test(String(f)));
}

// Global: every existing line goes, so a dispatch that already carries two of them cannot
// leave a stale tier behind the fresh one for the reviewer to read first.
const TIER_LINE = /^REVIEW_TIER:.*\n?/gm;

function withTierLine(prompt, tier) {
  const stripped = prompt.replace(TIER_LINE, "").replace(/\s+$/, "");
  return `${stripped}\nREVIEW_TIER: ${tier}`;
}

export function check(input, ctx) {
  const d = parseDispatch(input);
  if (!isQualityReviewer(d.subagentType)) return;

  const prompt = String(input?.tool_input?.prompt ?? "");
  if (UNTOUCHED_MODE.test(prompt))
    return ctx.allow(
      "whole-feature, migration or standalone review: not routed",
    );

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
  // The fork point is the session branch, which the session id names. The dispatch's own
  // BRANCH_NAME is only a fallback: the orchestrator's per-ticket reviewer dispatch does
  // not carry that line, and a base read from it alone would leave the diff unread.
  let base = "";
  try {
    base = sessionBranch(ctx);
  } catch {
    const m = d.branchName.match(/^([^/]+)\//);
    if (m) base = `session/${m[1]}`;
  }
  let stats = null;
  if (d.worktreePath && base) stats = diffStats(d.worktreePath, base);

  // Neither input: there is no tier to compute, and a REVIEW_TIER line invented here would
  // read as a real difficulty. A missing line is the reviewer's "hard", so leaving the
  // dispatch alone keeps the stronger model, the same direction as every other fail-open.
  if (!ticket && !stats)
    return ctx.allow("no ticket and no diff: left as dispatched");

  const fromDiff = stats ? tierFromDiff(stats) : null;
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
