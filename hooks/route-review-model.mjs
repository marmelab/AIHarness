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
//
// UNANCHORED on purpose. The orchestrator writes the feature review's mode INSIDE its
// ROLE line ("ROLE: quality-reviewer (MODE: feature-review)"), not on a line of its own,
// so a pattern anchored to line start reads no mode at all and downgrades the one pass
// with nothing downstream to catch it. Matching too much only leaves a dispatch as
// dispatched, which is the fail-open direction; matching too little is a silent
// downgrade.
const UNTOUCHED_MODE =
  /\bMODE:\s*(feature-review|feature-smoke|migration-review|review)\b/;

// A changed path whose blast radius reaches the database. Read from the ticket when there
// is one, and from the diff itself when there is not.
const SCHEMA_PATH = /(^|\/)supabase\//;

/** Does this ticket's blast radius reach the database? */
export function isSchemaSensitive(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  if (ticket.schema_sensitive === true) return true;
  const files = Array.isArray(ticket.files_to_modify)
    ? ticket.files_to_modify
    : [];
  return files.some((f) => SCHEMA_PATH.test(String(f)));
}

/**
 * Does this diff reach the database? The SIMPLE review carries no ticket, so without the
 * diff's own paths a one-file RLS or schema change would tier as trivial.
 * @param {string[] | undefined} paths
 */
export const isSchemaSensitiveDiff = (paths) =>
  Array.isArray(paths) && paths.some((f) => SCHEMA_PATH.test(String(f)));

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
  // One base for every reviewer dispatch: the session branch. setup-worktree cuts EVERY
  // worktree from it, the simple one included (`worktree add -b <branch> session/<short>`),
  // so the three-dot range against it is that worktree's own work and nothing else. The
  // anchor is the wrong base here: it sits behind whatever earlier waves merged into the
  // session branch, so a diff taken from it bills a one-file change for the whole session,
  // and one supabase/ path anywhere in that history would pin every later review to hard.
  //
  // The dispatch's own BRANCH_NAME is only a fallback for the short id: the orchestrator's
  // per-ticket reviewer dispatch does not carry that line, and a base read from it alone
  // would leave the diff unread.
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
  // An EMPTY diff is the same absence of signal as an unreadable one, so it counts here
  // too: with no ticket beside it, `normal` would be invented out of nothing.
  if (!ticket && (!stats || stats.files === 0))
    return ctx.allow("no ticket and no diff: left as dispatched");

  const fromDiff = stats ? tierFromDiff(stats) : null;
  const diffLabel =
    stats === null ? "none" : stats.files === 0 ? "empty" : fromDiff;
  // The ticket declares its blast radius; a ticket-less review has only the diff's paths.
  const schema = ticket
    ? isSchemaSensitive(ticket) === true
    : isSchemaSensitiveDiff(stats?.paths);
  const stored = ticket && TIERS.includes(ticket.tier) ? ticket.tier : null;
  // A ticket dispatch expects both inputs, so an ABSENT one is floored at `normal` rather
  // than ignored: a missing scorecard, an unreadable diff or an empty one is not evidence
  // of an easy ticket, and `maxTier`'s null-skipping would otherwise let a small diff or a
  // lone good scorecard carry the whole dispatch down to `trivial`, a weaker review than
  // the untiered one it replaced, invisible in the log because trivial and normal share a
  // model. The ticket-less SIMPLE path keeps the nulls: there, no scorecard is the normal
  // state and `trivial` is the intended saving.
  const scorecardTier = ticket ? (fromScorecard ?? "normal") : fromScorecard;
  const diffTier = ticket ? (fromDiff ?? "normal") : fromDiff;
  const tier = maxTier(scorecardTier, diffTier, schema ? "hard" : null, stored);

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
