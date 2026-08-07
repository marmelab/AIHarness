// Per-ticket review verdict flags. The presence of a flag means that reviewer
// returned APPROVED for the ticket.
//
// The ONLY writer is record-review-verdict.mjs (SubagentStop), which parses the
// reviewer's contract line through lib/verdict.mjs. The reviewer used to touch the
// flag itself before stopping; that made one Bash call in one agent prompt the single
// point of failure for the whole end-of-feature gate, and an agent writing its own
// gate file is the exact shape a CI-bypass check looks for. It survives only as an
// opt-in fallback (`WRITE_VERDICT_FLAG: yes` in the dispatch) for a runtime where a
// hook can read neither the last assistant message nor a flushed transcript.
//
// Read by block-merger-without-review.mjs (PreToolUse/Agent), cleared on REJECTED and
// when a developer is (re)dispatched (setup-worktree.mjs) so a changed diff invalidates
// stale approvals. Session-scoped under <sessionDir>/reviews, mirroring the
// <sessionDir>/flags convention.
//
// e2e-on-feature-review does NOT wait for this flag: it parses the same verdict with the
// same parser, so the two never disagree and neither depends on the other's write.
//
// Path source: the fallback write, when a dispatch asks for it, is done by the
// quality-reviewer agent, which derives the flag dir from its ticket file
// (`$(dirname TICKET_FILE)/reviews`), i.e. under the `<session_dir>` it was handed
// (TICKETS_DIR == <session_dir>, see orchestrator.md). Every reader here must resolve
// to that same dir or the two writers disagree.
// On a managed launcher (CRM Builder's chat-service) that `<session_dir>` is the dir
// named by `config.launcher.sessionDirEnv`, which is NOT the `/tmp/<repo>/<id>` path
// ctx.sessionDir recomputes, so the reader/clearer/fallback below resolve it through
// `sessionDirFromEnv()`, or they look in the wrong dir and the synchronous verdict is
// lost (block-merger then blocks on a phantom "no APPROVED"). With no managed
// launcher that env var is unset and ctx.sessionDir already equals <session_dir> (the
// session-bootstrap hook injects exactly that), so this is a no-op there.

import { rmSync } from "node:fs";
import { join } from "node:path";
import { sessionDirFromEnv } from "./config.mjs";

export const REVIEW_ROLES = ["quality-reviewer"];

// The end-of-feature review has no ticket, so its verdict flag is keyed on this
// sentinel instead of a TASK id: <sessionDir>/reviews/FEATURE-quality-reviewer.
// Shared because three places must agree on the spelling: e2e-on-feature-review reads
// the flag to decide whether to launch the suite, record-review-verdict writes it, and
// the quality-reviewer agent touches it on a `WRITE_VERDICT_FLAG: yes` dispatch.
export const FEATURE_KEY = "FEATURE";

export const reviewsDir = (ctx) =>
  join(sessionDirFromEnv() || ctx.sessionDir, "reviews");

export const reviewFlag = (ctx, taskId, role) =>
  join(reviewsDir(ctx), `${taskId}-${role}`);

// A worktree whose validation chain refused the stop too many times in a row: the developer
// could not get to green. The stop is released so the pipeline is not wedged, and this marker
// is what keeps the work from being merged anyway. Producer: lib/validation.mjs. Consumer:
// block-merger-without-review.mjs. Shared here so the two cannot disagree on the path.
export const validationGaveUpFlag = (ctx, taskId) =>
  join(sessionDirFromEnv() || ctx.sessionDir, "validation-gave-up", String(taskId));

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
