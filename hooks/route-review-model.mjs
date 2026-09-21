#!/usr/bin/env node
// PreToolUse(Agent): set the per-ticket review model from the ticket's difficulty tier:
// the planner's scorecard, the real diff, the schema sensitivity, the stored tier, the
// highest wins, by rewriting the dispatch rather than asking the orchestrator to
// remember the rule.
//
// Three directions, and they are NOT symmetric:
//
//   ordinary ticket   -> SET the tier's model, BELOW the agent's own (sonnet)
//   schema-sensitive  -> REMOVE model, so the agent file's `opus` applies
//   critical tier     -> SET the tier's model, ABOVE the agent's own, where one is named
//
// Removing rather than naming `opus` on the middle row is load-bearing: a runtime that
// ignores `model` leaves the reviewer on its declared default, so a downgrade that does
// not take effect costs tokens, never review depth. The third row is the one rewrite that
// fails downward, since a `model` the runtime ignores or rejects there drops the
// escalation.
//
// Both land on the same floor, and that is what makes the asymmetry safe: every failure
// path reviews with the agent's declared model, which is what EVERY review cost before
// the tiers existed. The optimisation can overspend and the escalation can fail to apply;
// no path reviews more weakly than the untiered harness did. Fail-open goes the same way:
// anything unreadable leaves the dispatch as dispatched.

import { readFileSync, writeFileSync } from "node:fs";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { isQualityReviewer } from "./lib/teams.mjs";
import { sessionBranch } from "./lib/topology.mjs";
import {
  deployGlobs,
  loadConfig,
  relevanceRegex,
  reviewTierModel,
} from "./lib/config.mjs";
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

/**
 * The matcher for a path whose blast radius reaches the database, read from
 * `deploy.relevantGlobs`: the project names its own deploy-relevant paths, the hook holds
 * no vendor name. A project with no deploy block declares no such path, so nothing
 * escalates on a path alone there, and a ticket's own `schema_sensitive` flag stays the
 * way to say so.
 *
 * A config that cannot be read at all is the opposite case, and it matches EVERY path. The
 * model is not enough on its own: `reviewTierModel` throws with it and the dispatch keeps
 * the strong model, but the depth the reviewer applies comes from the `REVIEW_TIER:` line,
 * so an empty matcher would stamp `normal` on a schema change while paying for opus. Both
 * halves fail in the same expensive direction instead.
 * @returns {RegExp}
 */
export function schemaPathRegex() {
  try {
    return relevanceRegex(deployGlobs(loadConfig()));
  } catch {
    return /^/; // unreadable config: every path is treated as schema-relevant
  }
}

/**
 * Does this ticket's blast radius reach the database?
 * @param {unknown} ticket
 * @param {RegExp} re  the project's deploy-relevance matcher
 */
export function isSchemaSensitive(ticket, re) {
  if (!ticket || typeof ticket !== "object") return null;
  if (ticket.schema_sensitive === true) return true;
  const files = Array.isArray(ticket.files_to_modify)
    ? ticket.files_to_modify
    : [];
  return files.some((f) => re.test(String(f)));
}

/**
 * Does this diff reach the database? The SIMPLE review carries no ticket, so without the
 * diff's own paths a one-file RLS or schema change would tier as trivial.
 * @param {string[] | undefined} paths
 * @param {RegExp} re  the project's deploy-relevance matcher
 */
export const isSchemaSensitiveDiff = (paths, re) =>
  Array.isArray(paths) && paths.some((f) => re.test(String(f)));

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
  const schemaRe = schemaPathRegex();
  const schema = ticket
    ? isSchemaSensitive(ticket, schemaRe) === true
    : isSchemaSensitiveDiff(stats?.paths, schemaRe);
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
    model = "default"; // unreadable config: the agent's own model, the floor above
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
