#!/usr/bin/env node
// SubagentStop(quality-reviewer): the ONLY writer of the reviewer's verdict flag
// (block-merger-without-review.mjs enforces dev -> reviewer -> merger on it).
// The reviewer used to touch the flag itself before stopping. That made one Bash
// call in one agent prompt the single point of failure for the end-of-feature gate,
// and an agent writing the file that gates its own review is the exact shape a
// CI-bypass check reports. The self-write survives only as an opt-in fallback, on a
// dispatch carrying `WRITE_VERDICT_FLAG: yes` (see quality-reviewer.md), for a
// runtime where no hook can read the verdict at all.
//
// The cost of being the only writer: at SubagentStop the reviewer's final contract
// line is sometimes not yet flushed to the transcript (and last_assistant_message is
// absent in this runtime), so recovery here returns UNKNOWN and the flag is left
// untouched on an APPROVED review. That reads downstream as "not approved", so the
// log line below has to say which of verdict, ticket or identity was missing:
// orchestrator.md turns that line into the WRITE_VERDICT_FLAG re-dispatch.
// SubagentStop cannot block, it only records.
//
// Flag (presence == APPROVED): <sessionDir>/reviews/<TASK>-<role>. Cleared on
// REJECTED here; cleared on a developer (re)dispatch by setup-worktree.mjs so a
// changed diff invalidates stale approvals.
//
// Verdict source: the reviewer's final contract line (exactly `APPROVED` or
// `REJECTED: ...`). Read from last_assistant_message when the runtime provides
// it, else from the JSONL transcript's last assistant text block. When the
// verdict can't be recovered, the flag is left untouched — never written on a
// guess (a dev re-dispatch is what invalidates a stale verdict).

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHookContext } from "./lib/context.mjs";
import { getFirstTaskId, isQualityReviewer } from "./lib/teams.mjs";
import { agentTranscriptPath, readAgentMeta } from "./lib/agent-meta.mjs";
import { reviewMode } from "./lib/review-mode.mjs";
import { FEATURE_KEY, reviewFlag, reviewsDir } from "./lib/reviews.mjs";
import { reviewerVerdict } from "./lib/verdict.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
const ctx = createHookContext(input, "record-review-verdict");

// The STOPPING AGENT'S OWN transcript, not the payload's transcript_path: in this
// runtime that field names the MAIN session transcript, which holds every dispatch
// prompt and every orchestrator message of the session. Scanning it for `ROLE:` /
// `TASK_ID:` returned whatever was dispatched FIRST, and its "last assistant text" is
// the orchestrator's, not the reviewer's. "" when identity is unresolvable, which is
// safer than reading the wrong agent's words: the flag is then left untouched.
const transcript = agentTranscriptPath(input);

// Role + task from the (suffixed) agent identity, e.g. quality-reviewer-TASK-001.
const ids = [ctx.agentName, ctx.agentType].filter(Boolean);
let role = ids.some(isQualityReviewer) ? "quality-reviewer" : "";
let task = "";
for (const n of ids) {
  const m = getFirstTaskId(n);
  if (m) {
    task = m;
    break;
  }
}

// Most reliable source at SubagentStop: the sibling <agent>.meta.json. It is
// written at spawn (so it exists even when the big transcript JSONL hasn't been
// flushed yet — a real race here) and carries agentType + the dispatch
// description. In this runtime the payload's `agent_type` is empty and
// `transcript_path` can point at a not-yet-written file, so prefer the meta.
if (!role || !task) {
  const meta = readAgentMeta(input);
  if (meta) {
    if (!role && isQualityReviewer(meta.agentType)) role = "quality-reviewer";
    if (!task) {
      const m = meta.description.match(/TASK-\d+/);
      if (m) task = m[0];
    }
  }
}

// No suffixed agent name in this harness → recover task/role from the dispatch
// prompt in the transcript. Done unconditionally: lastAssistantText() returns
// early on last_assistant_message, bypassing its own recovery (→ task=UNKNOWN).
if (!role || !task) {
  if (transcript && existsSync(transcript)) {
    let body = "";
    try {
      body = readFileSync(transcript, "utf8");
    } catch {
      body = "";
    }
    for (const line of body.split("\n")) {
      if (!role) {
        const m = line.match(/(?:^|\\n|")ROLE:\s*(quality-reviewer)/);
        if (m) role = m[1];
      }
      if (!task) {
        const m =
          line.match(/TASK_ID[:=\s]+(TASK-\d+)/) ||
          line.match(/TICKET_FILE[=:\s]+\S*(TASK-\d+)/);
        if (m) task = m[1];
      }
      if (role && task) break;
    }
  }
}

// The verdict, from the reviewer's final contract line. Parsing lives in lib/verdict.mjs,
// shared with e2e-on-feature-review so the hook that RECORDS the verdict and the hook that
// ACTS on it cannot read the same message differently. "" when no clean marker is present,
// and the flag is then left untouched: never written on a guess.
const verdict = reviewerVerdict(input);

// The end-of-feature review has NO ticket, so every TASK-id recovery above comes back
// empty and the flag could not be keyed at all. A reviewer whose dispatch carried
// `MODE: feature-review` is keyed on the shared FEATURE sentinel instead. Reviewer role
// only: a developer or merger stop must never be able to write a review verdict.
if (role && !task && reviewMode(input) === "feature-review") task = FEATURE_KEY;

// Only log for reviewer stops. This hook fires on EVERY subagent stop (the
// SubagentStop matcher doesn't filter and agent_type is empty in this runtime),
// so logging non-reviewer stops (developer/merger/planner/…) is pure noise.
// `role` found OR a verdict in the final message ⇒ this was a reviewer.
if (role || verdict) {
  const meta = readAgentMeta(input);
  ctx.log(
    `role=${role || "UNKNOWN"} task=${task || "UNKNOWN"} verdict=${verdict || "UNKNOWN"}` +
      (role && task && verdict
        ? ""
        : ` | DIAG identity=${meta ? meta.source : "unresolved"} agent_transcript=${transcript ? "resolved" : "unresolved"} last_msg=${input.last_assistant_message ? "present" : "absent"}`),
  );
}

if (!role || !task) process.exit(0); // can't key the flag — leave state untouched

const flag = reviewFlag(ctx, task, role);
if (verdict === "APPROVED") {
  try {
    mkdirSync(reviewsDir(ctx), { recursive: true });
    writeFileSync(flag, "");
  } catch {
    // best-effort
  }
} else if (verdict === "REJECTED") {
  try {
    rmSync(flag, { force: true });
  } catch {
    // best-effort
  }
}
// UNKNOWN verdict: leave the flag untouched.
process.exit(0);
