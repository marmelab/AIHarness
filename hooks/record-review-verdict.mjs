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
// line is sometimes not yet flushed to the transcript, so recovery here returns
// UNKNOWN and the flag is left untouched on an APPROVED review. Measured, the payload
// does carry `last_assistant_message` and it holds the contract line, so that is the
// primary source and the transcript is the fallback. That reads downstream as "not approved", so the
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
import { join } from "node:path";
import { createHookContext } from "./lib/context.mjs";
import { getFirstTaskId, isQualityReviewer } from "./lib/teams.mjs";
import {
  agentTranscriptPath,
  isPhantomStop,
  readAgentMeta,
} from "./lib/agent-meta.mjs";
import { reviewMode } from "./lib/review-mode.mjs";
import { FEATURE_KEY, reviewFlag, reviewsDir } from "./lib/reviews.mjs";
import { reviewerVerdict, verdictSource } from "./lib/verdict.mjs";

// One integer per session, next to the other sentinels: `<session_dir>/phantom-stops`.
const bumpPhantomCount = (context) => {
  try {
    const file = join(context.sessionDir, "phantom-stops");
    let seen = 0;
    try {
      seen = parseInt(readFileSync(file, "utf8"), 10) || 0;
    } catch {
      seen = 0;
    }
    mkdirSync(context.sessionDir, { recursive: true });
    writeFileSync(file, `${seen + 1}\n`);
  } catch {
    // best-effort: a counter must never wedge a stop
  }
};

const input = JSON.parse(readFileSync(0, "utf8"));
const ctx = createHookContext(input, "record-review-verdict");

// The runtime fires a stop of its own every ~32 s while an agent runs. It names no agent,
// so identity falls to the newest-transcript guess, which lands on whichever reviewer is
// CURRENTLY running: the recovered role and task belong to that agent and its text is a
// mid-turn snapshot with no contract line yet. One request logged 173 such lines, every
// one of them `verdict=UNKNOWN`, drowning whatever the real stops said.
if (isPhantomStop(input)) {
  // Counted, not logged: one line every ~32 s would bury the stops that matter, and the
  // total is the number that says whether the filter is carrying the load it is meant to.
  bumpPhantomCount(ctx);
  process.exit(0);
}

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

// The ROLE is only ever taken from IDENTITY (payload agent_type, or the spawn meta),
// never recovered by scanning a transcript. Every SubagentStop hook now runs on every
// stop, so the orchestrator's own stop reaches this hook too — and its transcript holds
// the reviewer dispatch prompts IT wrote, `ROLE: quality-reviewer` and `TASK_ID:`
// included. Scanning for those made a summary that merely mentions APPROVED able to
// write the flag that gates the merge, which is the one thing this hook must never do
// on anything but a reviewer's own words.
const metaType = (() => {
  const meta = readAgentMeta(input);
  return meta ? meta.agentType : "";
})();
const identity = [ctx.agentName, ctx.agentType, metaType].find(Boolean) || "";
if (!identity) {
  const src = verdictSource(input);
  ctx.log(
    `identity unresolved, nothing recorded | DIAG agent_id=${input.agent_id ? "present" : "absent"} ` +
      `agent_transcript=${transcript ? "resolved" : "unresolved"} ` +
      `read_from=${src.source} tail=${JSON.stringify(src.tail)}`,
  );
  process.exit(0);
}
if (!isQualityReviewer(identity)) process.exit(0);
role = "quality-reviewer";

// The ticket, from the spawn meta's dispatch description ("Review TASK-001"). Written at
// spawn, so it is there even when the transcript JSONL has not been flushed yet.
if (!task) {
  const meta = readAgentMeta(input);
  if (meta) {
    const m = meta.description.match(/TASK-\d+/);
    if (m) task = m[0];
  }
}

// Still no ticket: the reviewer's own dispatch prompt names it. Safe to scan now that
// the role came from identity — this reads the ticket out of a transcript already known
// to be a reviewer's.
if (!task && transcript && existsSync(transcript)) {
  let body = "";
  try {
    body = readFileSync(transcript, "utf8");
  } catch {
    body = "";
  }
  for (const line of body.split("\n")) {
    const m =
      line.match(/TASK_ID[:=\s]+(TASK-\d+)/) ||
      line.match(/TICKET_FILE[=:\s]+\S*(TASK-\d+)/);
    if (m) {
      task = m[1];
      break;
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
// `MODE: feature-review` is keyed on the shared FEATURE sentinel instead.
if (!task && reviewMode(input) === "feature-review") task = FEATURE_KEY;

// Every stop that got this far IS a reviewer's, so every one of them is logged: what the
// verdict was, or which of ticket / verdict could not be recovered.
{
  const meta = readAgentMeta(input);
  ctx.log(
    `role=${role} task=${task || "UNKNOWN"} verdict=${verdict || "UNKNOWN"}` +
      (task && verdict
        ? ""
        : ` | DIAG identity=${meta ? meta.source : "unresolved"} agent_id=${input.agent_id ? "present" : "absent"} agent_transcript=${transcript ? "resolved" : "unresolved"} read_from=${verdictSource(input).source} tail=${JSON.stringify(verdictSource(input).tail)}`),
  );
}

if (!task) process.exit(0); // can't key the flag — leave state untouched

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
