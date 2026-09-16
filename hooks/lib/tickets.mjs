// The session's tickets, read from disk. Four readers depend on the SAME answer and must
// not derive it separately: session-state asks "is this session still in flight?",
// e2e-on-feature-review asks "was that the last wave's merge?", render-status asks what to
// put on the board, and warn-ungrilled-plan asks whether the approved plan was ever
// grilled. A ticket file one reader finds and another misses turns each of those questions
// into its own silent no: no suite ever runs, an empty board, a gate nobody warns about.
//
// Unreadable JSON counts as a ticket with status "unreadable", so a corrupt file can
// never be read as "nothing left to do".

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { scratchpadDir } from "./scratchpad.mjs";

export const TICKET_RE = /^TASK-\d+\.json$/;

/**
 * Every place a ticket file has been observed, in the order a reader should try them.
 *
 * The orchestrator is TOLD the session dir and does not always use it: tickets also turn
 * up in the runtime scratchpad (`/tmp/claude-<uid>/<project>/<id>/`), and a reader looking
 * only where the hooks keep their state then reports no tickets for a session that has
 * them. Reading the scratchpad too is a READ of a directory the session owns, not an
 * endorsement of writing tickets there: the mismatch is still a defect worth closing
 * upstream.
 *
 * One list, because two readers disagreeing about where the tickets are is how a gate
 * turns into a no-op nobody notices.
 * @param {object} ctx hook context
 * @param {string} [tmp] tmp root holding the claude-<uid> directories
 * @returns {string[]}
 */
export function ticketDirs(ctx, tmp) {
  const dirs = [ctx.ticketsDir, ctx.sessionDir];
  try {
    const pad = tmp
      ? scratchpadDir(ctx.sessionId, tmp)
      : scratchpadDir(ctx.sessionId);
    // Tickets sit next to the scratchpad, not inside it.
    if (pad) dirs.push(dirname(pad));
  } catch {
    // no session id / unreadable /tmp -> the two dirs above still answer
  }
  return dirs;
}

/** @param {object} ctx hook context @returns {Array<Record<string, unknown>>} */
export function readTickets(ctx) {
  for (const dir of ticketDirs(ctx)) {
    if (!dir || !existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter((f) => TICKET_RE.test(f));
    } catch {
      continue;
    }
    if (!files.length) continue;
    return files.sort().map((f) => {
      try {
        return JSON.parse(readFileSync(join(dir, f), "utf8"));
      } catch {
        return { status: "unreadable" };
      }
    });
  }
  return [];
}

/**
 * Every planned ticket is merged into the session branch — i.e. the wave is over.
 * False for a session with no tickets at all: SIMPLE has nothing to be done with.
 */
export const allTicketsMerged = (tickets) =>
  tickets.length > 0 && tickets.every((t) => t?.status === "merged");
