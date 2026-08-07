#!/usr/bin/env node
// SubagentStop(quality-reviewer) — record what a feature-smoke actually did.
//
// The smoke has no verdict flag: its result reaches the orchestrator as text only, so
// nothing downstream can tell a smoke that walked the flows from one that read the
// source and approved. This hook writes the fact to <session_dir>/smoke-result.json,
// the way e2e-on-feature-review writes e2e-result.json, and completion-invariant
// reacts to it at the orchestrator's stop.
//
// It records; it never blocks. `status: "approved-no-evidence"` is the only judgement
// it makes, and only when the transcript was readable: an unreadable transcript is
// "could not look", which is not the same claim.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHookContext } from "./lib/context.mjs";
import { agentTranscriptPath } from "./lib/agent-meta.mjs";
import { reviewMode } from "./lib/review-mode.mjs";
import { browserEvidence } from "./lib/smoke-evidence.mjs";
import { reviewerVerdict } from "./lib/verdict.mjs";

let ctx;
try {
  const raw = readFileSync(0, "utf8");
  ctx = createHookContext(raw, "record-smoke-evidence");
  const payload = JSON.parse(raw);

  // Every SubagentStop hook fires on every stop (the matchers do not filter and
  // agent_type is empty), so the MODE line in the agent's own dispatch prompt is what
  // makes this stop ours.
  if (reviewMode(payload) !== "feature-smoke") process.exit(0);

  const verdict = reviewerVerdict(payload);
  const evidence = browserEvidence(agentTranscriptPath(payload));

  const status = !evidence.readable
    ? "unknown"
    : verdict === "APPROVED" && !evidence.any
      ? "approved-no-evidence"
      : verdict === "APPROVED"
        ? "approved"
        : verdict === "REJECTED"
          ? "blocked"
          : "unknown";

  const result = {
    status,
    verdict: verdict || "UNKNOWN",
    evidence: { mcp: evidence.mcp, bash: evidence.bash },
    at: new Date().toISOString(),
  };
  writeFileSync(
    join(process.env.CHAT_SESSION_DIR || ctx.sessionDir, "smoke-result.json"),
    `${JSON.stringify(result)}\n`,
  );
  ctx.log(
    `status=${status} verdict=${result.verdict} mcp=${evidence.mcp} bash=${evidence.bash}`,
  );
} catch (e) {
  // Fail-open: a recorder must never wedge a stop.
  if (ctx) ctx.log(`error, accepting: ${String(e).slice(0, 140)}`);
}
process.exit(0);
