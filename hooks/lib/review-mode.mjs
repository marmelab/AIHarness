// Which KIND of review a stopping quality-reviewer was running: the end-of-feature
// `MODE: feature-review`, its `MODE: feature-smoke` sibling, or neither (a per-ticket
// review).
//
// Two hooks must agree on this, which is why it is here and not inlined in either.
// e2e-on-feature-review decides whether to pay for a 10-minute suite; and
// record-review-verdict decides whether a verdict with no TASK id belongs to the
// feature review (flag key FEATURE) or cannot be keyed at all. When they disagreed the
// suite could run against a verdict nobody had recorded.
//
// Two conditions, and BOTH were needed to stop the suite relaunching itself:
//
//   1. The stopping agent is a quality-reviewer. Nobody else is ever in a review mode.
//   2. The `MODE:` line is in that agent's DISPATCH PROMPT.
//
// Dropping either one reintroduces the livelock. The `MODE:` line was read from the
// stopping agent's whole transcript, which is right up until the agent is the
// ORCHESTRATOR: it wrote `MODE: feature-review` itself, into its own transcript, when
// it dispatched the reviewer. Every orchestrator stop after that answered
// "feature-review" and relaunched the suite, which flipped e2e-result.json back to
// `running`, which is precisely the file the orchestrator was waiting on before it
// could finalise. 14 suite runs in one session where 2 were wanted, and the loop only
// ended when the main thread stopped resuming the orchestrator.
//
// The role check alone would not have been enough either: identity came back from the
// newest-dispatch GUESS, which named a quality-reviewer that had stopped minutes
// earlier. It holds now because agent-meta resolves the role from CLAUDE_AGENT_NAME
// first and drops a contradicting guess's transcript.
//
// A `feature-smoke` match ENDS the lookup rather than falling through to the dispatch
// description. The smoke dispatch has no description template, so an improvised
// description containing "feature-review" would otherwise trigger a second, duplicate
// suite run.

import { dispatchPrompt, readAgentMeta } from "./agent-meta.mjs";
import { isQualityReviewer } from "./teams.mjs";

const MODE_LINE = /MODE:\s*(feature-review|feature-smoke)/;

/**
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {"feature-review" | "feature-smoke" | ""}
 */
export function reviewMode(payload) {
  const meta = readAgentMeta(payload);
  if (!meta || !isQualityReviewer(meta.agentType)) return "";
  const m = dispatchPrompt(payload).match(MODE_LINE);
  if (m) return m[1];
  // No dispatch prompt on disk yet (or no MODE line in it): the spawn description is
  // the only other thing written at dispatch time, so it is the last resort.
  return /feature-review/i.test(meta.description) ? "feature-review" : "";
}

/** @param {Record<string, unknown>} payload */
export const isFeatureReview = (payload) =>
  reviewMode(payload) === "feature-review";
