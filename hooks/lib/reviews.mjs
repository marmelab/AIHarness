// Per-ticket review verdict flags. The presence of a flag means that reviewer
// returned APPROVED for the ticket. PRIMARY writer is the quality-reviewer agent
// itself — it touches the flag via Bash as its last action before emitting the
// contract line (see quality-reviewer.md), so the verdict is recorded
// synchronously and never depends on a post-stop transcript read. FALLBACK writer
// is record-review-verdict.mjs (SubagentStop), kept as belt-and-suspenders for the
// case the reviewer forgot the touch. Read by block-merger-without-review.mjs
// (PreToolUse/Agent), cleared on REJECTED and when a developer is (re)dispatched
// (setup-worktree.mjs) so a changed diff invalidates stale approvals. Session-scoped
// under <sessionDir>/reviews, mirroring the <sessionDir>/flags convention.
//
// Path source: the quality-reviewer agent (PRIMARY writer) derives the flag dir
// from its ticket file — `$(dirname TICKET_FILE)/reviews` — i.e. under the
// `<session_dir>` it was handed (TICKETS_DIR == <session_dir>, see orchestrator.md).
// On a managed launcher (CRM Builder's chat-service) that `<session_dir>` is
// `CHAT_SESSION_DIR`, which is NOT the `/tmp/<repo>/<id>` path ctx.sessionDir
// recomputes — so the reader/clearer/fallback below must key off CHAT_SESSION_DIR
// when present, or they look in the wrong dir and the synchronous verdict is lost
// (block-merger then blocks on a phantom "no APPROVED"). With no managed launcher,
// CHAT_SESSION_DIR is unset and ctx.sessionDir already equals <session_dir> (the
// session-bootstrap hook injects exactly that), so this is a no-op there.

import { rmSync } from "node:fs";
import { join } from "node:path";

export const REVIEW_ROLES = ["quality-reviewer"];

export const reviewsDir = (ctx) =>
  join(process.env.CHAT_SESSION_DIR || ctx.sessionDir, "reviews");

export const reviewFlag = (ctx, taskId, role) =>
  join(reviewsDir(ctx), `${taskId}-${role}`);

// A worktree whose validation chain refused the stop too many times in a row: the developer
// could not get to green. The stop is released so the pipeline is not wedged, and this marker
// is what keeps the work from being merged anyway. Producer: lib/validation.mjs. Consumer:
// block-merger-without-review.mjs. Shared here so the two cannot disagree on the path.
export const validationGaveUpFlag = (ctx, taskId) =>
  join(
    process.env.CHAT_SESSION_DIR || ctx.sessionDir,
    "validation-gave-up",
    String(taskId),
  );

// Cleared when that worktree's whole chain passes: giving up must be recoverable, or the
// documented fix ("dispatch a developer to fix the failing step") cannot work and the ticket is
// dead for the session with no exit but deleting the file the block message forbids deleting.
export const clearValidationGaveUp = (ctx, taskId) => {
  try {
    rmSync(validationGaveUpFlag(ctx, taskId), { force: true });
  } catch {
    /* absent - fine */
  }
};
