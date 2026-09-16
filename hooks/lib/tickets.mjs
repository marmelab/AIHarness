// The session's tickets, read from disk. Two gates depend on the SAME answer and must
// not derive it separately: session-state asks "is this session still in flight?" and
// e2e-on-feature-review asks "was that the last wave's merge?". A ticket file that one
// reader finds and the other misses turns the second question into "no suite ever runs".
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
 * The orchestrator is TOLD the session dir and does not always use it: one run wrote all
 * five tickets into the runtime scratchpad (`/tmp/claude-<uid>/<project>/<id>/`) instead,
 * so a reader looking only where the hooks keep their state saw no tickets for a session
 * that had five. Reading the scratchpad too is a READ of a directory the session owns, not
 * an endorsement of writing tickets there: the mismatch is still a defect worth closing
 * upstream.
 *
 * One list, because two readers disagreeing about where the tickets are is how a gate
 * turns into a no-op nobody notices.
 * @param {object} ctx hook context
 * @returns {string[]}
 */
export function ticketDirs(ctx) {
  const dirs = [ctx.ticketsDir, ctx.sessionDir];
  try {
    const pad = scratchpadDir(ctx.sessionId);
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
