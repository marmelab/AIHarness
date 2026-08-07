// Did the agent that just stopped actually FINISH, or is this one of its turn breaks?
//
// SubagentStop does not mean "the agent is done". Measured over one run: 78 validation
// chains for about 13 developer dispatches, at a steady ~33s cadence, and 21 of them
// rejected the stop for uncommitted work while the developer was still mid-edit (the
// first rejection of one ticket arrived with a single modified file). After two
// rejections the format step commits the work itself, so that run shipped two
// `chore(TASK-XXX): commit work the agent left uncommitted` commits into the session
// branch. The agent was not leaving anything: it had not finished.
//
// What DOES mean "finished" is the thing every harness agent is required to end on: its
// output-contract line (rules/agent-output-format.md). A stop whose last assistant
// message carries no contract line is a turn break, and the hooks that act on a
// completed agent have no business acting on it.
//
// Read bottom-up and anchored at line start, the way verdict.mjs reads a verdict, so a
// contract word quoted mid-sentence is not mistaken for the line itself. A negative
// verdict is followed by its findings list, which is why the marker is not required to
// be the very last line.
//
// The one thing this must never do is claim "not finished" when it simply could not
// look. An empty or unreadable last message returns UNKNOWN, and every caller treats
// UNKNOWN as "proceed as before": a hook that silently stopped validating because a
// transcript was slow to flush would be a worse bug than the one this fixes.

import { bareRole } from "./teams.mjs";
import { lastAssistantText } from "./verdict.mjs";

// Per rules/agent-output-format.md, including the two skill-driven developer dispatches
// (`writing-migrations` emits NO_MIGRATION_NEEDED; `resolving-rollback-conflicts` emits
// the ordinary DONE:).
const CONTRACTS = [
  {
    roles: ["developer", "simple-developer", "test-writer"],
    re: /^(DONE:|FAILED:|NO_MIGRATION_NEEDED\b)/,
  },
  { roles: ["merger"], re: /^(DONE:|FAILED:)/ },
  { roles: ["quality-reviewer"], re: /^(APPROVED\b|REJECTED:|BLOCKED:)/ },
  { roles: ["planner"], re: /^(DONE:|FAILED:)/ },
];

const contractFor = (identity) => {
  const bare = bareRole(identity);
  const hit = CONTRACTS.find((c) =>
    c.roles.some((r) => new RegExp(`^${r}([-@]|$)`).test(bare)),
  );
  return hit ? hit.re : null;
};

/**
 * Does `text` end on the output contract of `identity`'s role?
 *
 * @param {string} text
 * @param {string} identity  Agent role, bare or namespaced, suffixed or not.
 * @returns {boolean}  false when the role declares no contract.
 */
export function hasContractLine(text, identity) {
  const re = contractFor(identity);
  if (!re) return false;
  const lines = String(text ?? "")
    .split("\n")
    .map((s) => s.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] && re.test(lines[i])) return true;
  }
  return false;
}

/**
 * Is this stop the agent's LAST one?
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @param {string} identity  Agent role, as the caller resolved it.
 * @returns {"finished" | "mid-turn" | "unknown"}
 *   "unknown" when the last message could not be read, or the role has no contract:
 *   callers must then behave exactly as they did before this file existed.
 */
export function turnState(payload, identity) {
  if (!contractFor(identity)) return "unknown";
  const text = lastAssistantText(payload);
  if (!text.trim()) return "unknown";
  return hasContractLine(text, identity) ? "finished" : "mid-turn";
}
