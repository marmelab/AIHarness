#!/usr/bin/env node
// PreToolUse(Agent): a SECOND review of the same ticket must carry the FIX_ROUND block,
// or it re-reads the whole ticket and pays the first pass's price to re-report it.
//
// Knowing that a dispatch IS a re-review is the hard part, and the review verdict flag
// cannot answer it: reviews.mjs writes that flag only on APPROVED and clears it on
// REJECTED and on every developer re-dispatch, so its absence is the normal state of a
// ticket about to be re-reviewed. So this guard keeps its own per-ticket count.
//
// A REFUSED attempt is still counted, or the retry that adds the block reads as the first
// review and is waved through without it.
//
// Fail open on ignorance: no TASK id, or nowhere to count, means allow. A missed narrowing
// costs one redundant pass; a wrongly blocked review wedges the wave.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { isQualityReviewer } from "./lib/teams.mjs";
import { sessionDirFromEnv } from "./lib/config.mjs";

// The whole-feature and migration passes have their own templates and narrowing block.
const WHOLE_FEATURE_MODE =
  /^MODE:\s*(feature-review|feature-smoke|migration-review)/m;

export const dispatchCountFile = (ctx, taskId) =>
  join(
    sessionDirFromEnv() || ctx.sessionDir,
    "review-dispatches",
    String(taskId),
  );

/** Count one more dispatch for `taskId`; 0 means there was nowhere to count it. */
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
