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
// The `MODE:` line is the precise signal: unlike the reviewer's FINAL message it sits
// at the top of the dispatch prompt, so it is long flushed by the time the agent stops.
//
// It is read from the STOPPING AGENT'S OWN transcript, resolved via agent-meta. Reading
// it from the payload's transcript_path is what the original did, and that path is the
// MAIN session transcript: it contains every dispatch prompt of the session, so one
// feature-review dispatch made this return "feature-review" for every subsequent stop.
//
// A `feature-smoke` match ENDS the lookup rather than falling through to the dispatch
// description. The smoke dispatch has no description template, so an improvised
// description containing "feature-review" would otherwise trigger a second, duplicate
// suite run.

import { existsSync, readFileSync } from "node:fs";
import { agentTranscriptPath, readAgentMeta } from "./agent-meta.mjs";

const MODE_LINE = /MODE:\s*(feature-review|feature-smoke)/;

/**
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {"feature-review" | "feature-smoke" | ""}
 */
export function reviewMode(payload) {
  const tp = agentTranscriptPath(payload);
  if (tp && existsSync(tp)) {
    try {
      const m = readFileSync(tp, "utf8").match(MODE_LINE);
      if (m) return m[1];
    } catch {
      // fall through to the dispatch description
    }
  }
  const meta = readAgentMeta(payload);
  return meta && /feature-review/i.test(meta.description)
    ? "feature-review"
    : "";
}

/** @param {Record<string, unknown>} payload */
export const isFeatureReview = (payload) =>
  reviewMode(payload) === "feature-review";
