#!/usr/bin/env node
// PreToolUse(Agent) — block dispatching a per-ticket merger until the
// quality-reviewer has recorded APPROVED for that ticket. With no SendMessage
// handshake, nothing else stops the orchestrator from going developer -> merger
// directly and skipping review; this gate enforces the
// dev -> reviewer -> (APPROVED) -> merger ordering structurally.
//
// Verdicts are recorded by record-review-verdict.mjs (SubagentStop) as flags
// under <sessionDir>/reviews/<TASK>-<role>. Skipped for the SIMPLE flow, the
// migration round, promotion-only, and rollback dispatches (no per-ticket
// review), and when the ticket can't be identified (fail open, never wedge the flow).

import { existsSync, readFileSync } from "node:fs";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import {
  REVIEW_ROLES,
  reviewFlag,
  validationGaveUpFlag,
} from "./lib/reviews.mjs";

export function check(input, ctx) {
  const d = parseDispatch(input);

  if (d.subagentType !== "merger") return; // only gate merger dispatches
  if (d.mode === "promote") return; // promotion-only carries no per-ticket review
  if (["SIMPLE", "MIGRATION", "PROMOTE", "ROLLBACK"].includes(d.taskId)) return;
  if (!/^TASK-\d+$/.test(d.taskId)) return; // can't identify a ticket -> fail open

  checkValidationGaveUp(ctx, d);
  checkApproved(ctx, d);
}

// The validation chain gave up on this ticket: it refused the developer's stop up to its
// limit and released it rather than wedging the pipeline. The work is therefore NOT green,
// and this is where "we never merge red" is enforced, mechanically, instead of relying on
// the orchestrator to have read a result file.
function checkValidationGaveUp(ctx, d) {
  const gaveUp = validationGaveUpFlag(ctx, d.taskId);
  if (!existsSync(gaveUp)) return;
  let detail = "";
  try {
    const r = JSON.parse(readFileSync(gaveUp, "utf8"));
    detail = ` (step \`${r.step}\` failed ${r.attempts} times)`;
  } catch {
    /* the marker's presence is the signal; its contents are a nicety */
  }
  ctx.fail(
    `Refusing to dispatch the merger for ${d.taskId}: its validation never reached green${detail}.\n` +
      "The developer's stop was released so the pipeline would not wedge, but the work is not " +
      "mergeable. Do NOT delete the marker and do NOT re-dispatch the merger: either dispatch a " +
      "developer to actually fix the failing step, or report this ticket as failed in your " +
      `handoff and carry on with the others. Details: ${gaveUp}`,
    { log: `BLOCK ${d.taskId} validation gave up` },
  );
}

function checkApproved(ctx, d) {
  const missing = REVIEW_ROLES.filter(
    (role) => !existsSync(reviewFlag(ctx, d.taskId, role)),
  );
  if (missing.length === 0) return; // APPROVED -> allow the merge

  ctx.fail(
    `Refusing to dispatch the merger for ${d.taskId}: no APPROVED verdict from ${missing.join(" and ")} yet.\n` +
      "The flow is: developer -> quality-reviewer -> (APPROVED) -> merger.\n" +
      `Dispatch quality-reviewer-${d.taskId} first (STATE B transition), then dispatch the merger only after it returns APPROVED.`,
    { log: `BLOCK ${d.taskId} missing=${missing.join(",")}` },
  );
}

runStandalone(import.meta.url, "block-merger-without-review", check);
