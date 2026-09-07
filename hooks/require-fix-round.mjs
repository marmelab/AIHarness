#!/usr/bin/env node
// PreToolUse(Agent): a SECOND review of the same ticket must be narrowed to the fix.
//
// orchestrator.md has asked for this since 2026-08-13: a re-review reuses the Stage 2
// prompt plus FIX_ROUND / FIX_RANGE / FINDINGS_RAISED, so the reviewer judges whether the
// raised findings are resolved instead of re-reading the whole ticket from scratch.
// Without those lines a re-review is a second full pass that costs as much as the first
// and mostly re-reports what it already said.
//
// As a prompt instruction it held half the time: of the 6 re-reviews in the three
// benchmark runs that postdate the rule, 3 carried FIX_ROUND and 3 did not.
//
// The mechanical part is knowing that a dispatch IS a re-review, and the review verdict
// flag cannot answer it: reviews.mjs writes that flag only on APPROVED, and clears it on
// REJECTED and on every developer re-dispatch, so its absence is the normal state of a
// ticket about to be re-reviewed. So this guard counts the reviewer dispatches it sees per
// TASK id, which needs no cooperation from any other hook: dispatch 1 is the review,
// dispatch 2 and up are re-reviews.
//
// The counter is written by the guard that reads it, one file per ticket under
// <sessionDir>/review-dispatches/. Session-scoped like every other marker, so two sessions
// on the same repo never share a count.
//
// FAIL OPEN on ignorance: no TASK id, or no session state to count in, means allow. The
// cost of a missed narrowing is one redundant pass; the cost of blocking a review that was
// fine is a wedged wave.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { isQualityReviewer } from "./lib/teams.mjs";
import { sessionDirFromEnv } from "./lib/config.mjs";

// The whole-feature and migration passes have their own narrowing block and their own
// dispatch templates; this guard is about per-ticket reviews.
const WHOLE_FEATURE_MODE =
  /^MODE:\s*(feature-review|feature-smoke|migration-review)/m;

export const dispatchCountFile = (ctx, taskId) =>
  join(
    sessionDirFromEnv() || ctx.sessionDir,
    "review-dispatches",
    String(taskId),
  );

/**
 * Record one more reviewer dispatch for `taskId` and return the new total.
 * Returns 0 when there is nowhere to count, which the caller reads as "cannot know".
 */
export function countDispatch(ctx, taskId) {
  try {
    const file = dispatchCountFile(ctx, taskId);
    mkdirSync(join(file, ".."), { recursive: true });
    let seen = 0;
    try {
      seen = parseInt(readFileSync(file, "utf8"), 10) || 0;
    } catch {
      seen = 0;
    }
    writeFileSync(file, `${seen + 1}\n`);
    return seen + 1;
  } catch {
    return 0;
  }
}

export function check(input, ctx) {
  const d = parseDispatch(input);
  if (!isQualityReviewer(d.subagentType)) return;

  const prompt = String(input?.tool_input?.prompt ?? "");
  if (WHOLE_FEATURE_MODE.test(prompt))
    return ctx.allow(
      "whole-feature or migration review: not a per-ticket pass",
    );
  if (!d.taskId)
    return ctx.allow("no TASK_ID: cannot tell a re-review from a review");

  const n = countDispatch(ctx, d.taskId);
  if (n === 0) return ctx.allow(`${d.taskId}: no session state to count in`);
  if (n === 1) return ctx.allow(`${d.taskId}: first review`);

  if (/^FIX_ROUND:/m.test(prompt))
    return ctx.allow(`${d.taskId}: re-review ${n}, narrowed`);

  ctx.fail(
    `This is review ${n} of ${d.taskId}, so it is a RE-review and must be narrowed to the fix. ` +
      `Re-issue the same dispatch with these three lines appended to the prompt:\n` +
      `  FIX_ROUND: <retry number>\n` +
      `  FIX_RANGE: <the developer's pre-retry HEAD>..<its new DONE commit>\n` +
      `  FINDINGS_RAISED: <the previous REJECTED verdict body, verbatim>\n` +
      `Without them the reviewer re-reads the whole ticket and pays the full price of the ` +
      `first pass to re-report what it already said. See orchestrator.md Stage 2 and ` +
      `quality-reviewer.md "A FIX_ROUND: block narrows the pass to the fix".`,
    { log: `BLOCK ${d.taskId} re-review ${n} without FIX_ROUND` },
  );
}

runStandalone(import.meta.url, "require-fix-round", check);
