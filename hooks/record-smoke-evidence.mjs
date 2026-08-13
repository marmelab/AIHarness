#!/usr/bin/env node
// SubagentStop(quality-reviewer): record whether a runtime check actually ran one.
//
// A runtime check has no verdict flag: its result reaches the orchestrator as text only,
// so nothing downstream can tell a check that walked the flows from one that read the
// source and approved. This hook writes the fact to <session_dir>/smoke-result.json,
// the way e2e-on-feature-review writes e2e-result.json, and completion-invariant
// reacts to it at the orchestrator's stop.
//
// Two dispatch shapes ask for one, and both are ours:
//
//   - `MODE: feature-smoke`, the standalone smoke;
//   - `MODE: feature-review` carrying a `RUNTIME_CHECK:` block, which is the same work
//     folded into the review that precedes it. Running the two as separate opus agents
//     cost 17.5 minutes of a 113-minute run to judge one diff twice.
//
// The `RUNTIME_CHECK:` marker is what makes the fused case ours, not the mode alone: a
// feature review of a diff that changes no UI is asked for no flows, and judging it for
// driving no browser would be a false positive on every docs or backend change.
//
// It records; it never blocks. `status: "approved-no-evidence"` is the only judgement
// it makes, and only when the transcript was readable: an unreadable transcript is
// "could not look", which is not the same claim.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDirFromEnv } from "./lib/config.mjs";
import { createHookContext } from "./lib/context.mjs";
import {
  agentTranscriptPath,
  dispatchPrompt,
  isPhantomStop,
} from "./lib/agent-meta.mjs";
import { reviewMode } from "./lib/review-mode.mjs";
import { browserEvidence } from "./lib/smoke-evidence.mjs";
import { reviewerVerdict } from "./lib/verdict.mjs";

let ctx;
try {
  const raw = readFileSync(0, "utf8");
  ctx = createHookContext(raw, "record-smoke-evidence");
  const payload = JSON.parse(raw);

  // A stop the runtime fires for its own book-keeping, every ~32 s while an agent runs.
  // It names no agent, so identity falls to the newest-transcript guess, which lands on
  // whichever reviewer is CURRENTLY running — and this file is rewritten whole each time.
  // Over one feature review that is 27 overwrites from mid-turn snapshots, each with the
  // browser evidence present and no contract line yet, so the last writer always leaves
  // `unknown`. The real stop's record never survives.
  if (isPhantomStop(payload)) process.exit(0);

  // Every SubagentStop hook fires on every stop (the matcher is `.*` on purpose — a role
  // token cannot match a plugin's namespaced agent_type, see rules/hook-authoring.md), so
  // the MODE line in the agent's OWN dispatch prompt is what makes this stop ours.
  const mode = reviewMode(payload);
  const asksForRuntimeCheck =
    mode === "feature-smoke" ||
    (mode === "feature-review" &&
      /RUNTIME_CHECK:/.test(dispatchPrompt(payload)));
  if (!asksForRuntimeCheck) process.exit(0);

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
    join(sessionDirFromEnv() || ctx.sessionDir, "smoke-result.json"),
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
