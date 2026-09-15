// The session's tickets, read from disk. Two gates depend on the SAME answer and must
// not derive it separately: session-state asks "is this session still in flight?" and
// e2e-on-feature-review asks "was that the last wave's merge?". A ticket file that one
// reader finds and the other misses turns the second question into "no suite ever runs".
//
// Unreadable JSON counts as a ticket with status "unreadable", so a corrupt file can
// never be read as "nothing left to do".

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TICKET_RE = /^TASK-\d+\.json$/;

/** @param {object} ctx hook context @returns {Array<Record<string, unknown>>} */
export function readTickets(ctx) {
  for (const dir of [ctx.ticketsDir, ctx.sessionDir]) {
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
