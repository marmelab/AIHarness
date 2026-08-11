// The quality-reviewer's verdict, parsed from its final contract line.
//
// Two hooks act on the same verdict and must never disagree: record-review-verdict writes
// the per-ticket / FEATURE flag from it, and e2e-on-feature-review decides whether to pay
// for a 10-minute suite. Shared here so neither carries its own copy
// (rules/hook-authoring.md).
//
// Two contract vocabularies, because the agent uses two. The COMPLEX-wave per-ticket
// review ends on `APPROVED` or `REJECTED:`; the feature-review, SIMPLE and migration
// passes end on `APPROVED` or `BLOCKED:` (see agents/quality-reviewer.md). A parser that
// knows only REJECTED reads a BLOCKED feature review as unparseable, leaves any earlier
// APPROVED flag in place, and the suite then runs on work the reviewer just refused.
// Both negatives are recognised, and both map to a single REJECTED result: the callers
// care whether the review passed, not which word said no.

import { existsSync, readFileSync } from "node:fs";
import { agentTranscriptPath } from "./agent-meta.mjs";

/**
 * Parse a verdict out of the reviewer's final message.
 *
 * Read bottom-up, taking the first CLEAN contract marker. The contract puts the verdict on
 * the final line as a bare `APPROVED`, or as `REJECTED:` / `BLOCKED:` followed by a
 * bulleted findings list, so the negative marker is NOT the last line. Lines that are
 * neither a clean marker nor a finding are skipped.
 *
 * Two deliberate asymmetries stop a chatty trailing line from FLIPPING a real verdict:
 *   - APPROVED matches only a standalone `APPROVED` (trailing punctuation allowed), never
 *     prose like "APPROVED parts: ...".
 *   - a negative requires the contract colon, so a trailing sentence such as "REJECTED
 *     concerns are now resolved" after a real APPROVED is ignored.
 *
 * @param {string} text
 * @returns {"APPROVED" | "REJECTED" | ""}  "" when no clean marker is present.
 */
export function parseVerdict(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((s) => s.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (/^(REJECTED|BLOCKED):/.test(line)) return "REJECTED";
    if (line.replace(/[.!\s]+$/, "") === "APPROVED") return "APPROVED";
  }
  return "";
}

/**
 * The reviewer's last assistant text: the payload field when the runtime provides it, else
 * the last assistant text block of the stopping agent's OWN transcript (resolved through
 * agent-meta, never the payload's transcript_path, which names the main session
 * transcript).
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {string}
 */
export function lastAssistantText(payload) {
  const direct = payload && payload.last_assistant_message;
  if (typeof direct === "string" && direct.trim()) return direct;

  const transcript = agentTranscriptPath(payload);
  if (!transcript || !existsSync(transcript)) return "";
  let body = "";
  try {
    body = readFileSync(transcript, "utf8");
  } catch {
    return "";
  }
  let lastText = "";
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = (event && event.message) || event;
    // ASSISTANT text only. Without this the first thing scanned is the transcript's
    // opening user event, whose content is the dispatch prompt, so an agent that has not
    // spoken yet "says" whatever it was asked to do. Harmless for a verdict, which a
    // prompt rarely ends on, and decisive for contract-line.mjs, which reads "no contract
    // line yet" out of the same text to tell a turn break from a finish.
    const role = msg && msg.role;
    const isAssistant = role
      ? role === "assistant"
      : event.type === "assistant";
    if (!isAssistant) continue;
    const content = msg && msg.content;
    if (Array.isArray(content)) {
      for (const b of content) {
        if (
          b &&
          b.type === "text" &&
          typeof b.text === "string" &&
          b.text.trim()
        )
          lastText = b.text;
      }
    } else if (typeof content === "string" && content.trim()) {
      lastText = content;
    }
  }
  return lastText;
}

/**
 * The stopping reviewer's verdict: "APPROVED", "REJECTED", or "" when it cannot be parsed.
 * An unparseable verdict is never treated as either outcome; each caller decides what to
 * do with the doubt.
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {"APPROVED" | "REJECTED" | ""}
 */
export const reviewerVerdict = (payload) =>
  parseVerdict(lastAssistantText(payload));

/**
 * What the verdict was actually parsed FROM, for a diagnostic line.
 *
 * A whole run once logged 173 stops with an unrecognised verdict while twelve of its
 * fifteen reviewers ended on a clean `APPROVED` — the parser replays those transcripts
 * correctly, so the text the hook was handed at runtime was not the text the reviewer
 * finished on. Nothing in the log could tell the two apart: the diagnostic said only that
 * a last message was "present". Which source answered, and how that text ends, is the one
 * fact that settles it, and it costs a substring.
 *
 * The tail only, and stripped of newlines: this goes in a log line, and the interesting
 * part of a contract is always its end.
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {{ source: "payload" | "transcript" | "none", tail: string }}
 */
export function verdictSource(payload) {
  const direct = payload && payload.last_assistant_message;
  const fromPayload = typeof direct === "string" && direct.trim();
  const text = fromPayload ? direct : lastAssistantText(payload);
  return {
    source: fromPayload ? "payload" : text ? "transcript" : "none",
    tail: String(text || "")
      .trim()
      .slice(-70)
      .replace(/\s+/g, " "),
  };
}
