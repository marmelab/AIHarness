#!/usr/bin/env node
// PreToolUse(Agent): the plan gate was resumed, and nothing was ever grilled.
//
// The plan grill is asserted in prose and, without this, enforced nowhere: a coordinator
// that never runs the skill produces a run byte-identical to a plan that invented nothing.
// A guard that never fires reports nothing, and an invariant with no guard at all reports
// less.
//
// A hook cannot see the GATE level, so the moment is inferred from the dispatch instead:
// `<intent>execute-plan</intent>` means the coordinator is re-dispatching a fresh
// orchestrator because the human approved at the plan gate. That is the exact point by
// which the grill must already have happened, and under `GATE: none` no such re-dispatch
// exists at all, so an unattended run can never reach this guard.
//
// ADVISORY ONLY, by construction. The human has already approved this plan; a bookkeeping
// guard must not cost them the dispatch, so this reports on the non-blocking channel and
// lets the call through. It fails open on every kind of ignorance: no tickets, a ticket it
// cannot parse, no session id, another role, another intent. A missed warning costs one
// line of a board; a refused resume wedges an approved run.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { derivedCount, readGrill } from "./lib/acceptance.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { runStandalone } from "./lib/hook-chain.mjs";
import { isOrchestrator } from "./lib/teams.mjs";
import { TICKET_RE, ticketDirs } from "./lib/tickets.mjs";

const EXECUTE_PLAN = /<intent>\s*execute-plan\s*<\/intent>/;

/**
 * The first of `dirs` that holds ticket files, with them parsed.
 *
 * `unreadable: true` when one of them is not JSON: the grill record lives INSIDE the
 * ticket, so a file that cannot be read is a file that may carry it, and reporting on the
 * rest would be reporting on a set this guard does not actually know.
 * @param {string[]} dirs
 * @returns {{dir: string, tickets: unknown[], unreadable: boolean} | null}
 */
function firstTicketSet(dirs) {
  for (const dir of dirs) {
    if (!dir || !existsSync(dir)) continue;
    let files;
    try {
      files = readdirSync(dir).filter((f) => TICKET_RE.test(f));
    } catch {
      continue;
    }
    if (!files.length) continue;
    const tickets = [];
    let unreadable = false;
    for (const f of files.sort()) {
      try {
        tickets.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
      } catch {
        unreadable = true;
      }
    }
    return { dir, tickets, unreadable };
  }
  return null;
}

export function check(input, ctx) {
  const d = parseDispatch(input);
  // Not my business, and reached on every dispatch in the session: a line here would be a
  // line per dispatch saying nothing. The in-scope paths below all log.
  if (!isOrchestrator(d.subagentType)) return;
  if (!EXECUTE_PLAN.test(String(input?.tool_input?.prompt ?? ""))) return;

  const who = `${d.subagentType} <intent>execute-plan</intent>`;

  let dirs;
  try {
    dirs = ticketDirs(ctx);
  } catch {
    return ctx.allow(`${who}: no session id, nowhere to read tickets from`);
  }

  const found = firstTicketSet(dirs);
  if (!found)
    return ctx.allow(`${who}: no ticket file under ${dirs.join(", ")}`);
  if (found.unreadable)
    return ctx.allow(`${who}: unreadable ticket in ${found.dir}`);

  const derived = found.tickets.reduce((n, t) => n + derivedCount(t), 0);
  if (derived === 0)
    return ctx.allow(`${who}: ${found.dir} derived nothing, nothing to grill`);

  // One grilled ticket answers for the plan: the skill passes over every ticket once, so a
  // run in which it executed leaves at least one recorded decision behind.
  if (found.tickets.some((t) => readGrill(t).length > 0))
    return ctx.allow(`${who}: ${derived} derived row(s), grill recorded`);

  ctx.flag(
    `The plan gate was approved, but nothing on this plan was ever grilled: ` +
      `${derived} criteria the planner derived or questions it left open, across ` +
      `${found.tickets.length} ticket(s) in ${found.dir}, and no ticket carries a ` +
      `\`grill\` record. Those are the planner's own judgement calls, so the human ` +
      `approved decisions nobody put to them. Run \`Skill({skill: "plan-grill"})\` over ` +
      `${found.dir} in the MAIN thread before the next plan gate.`,
    { log: `${who}: ${derived} derived row(s), no grill in ${found.dir}` },
  );
}

runStandalone(import.meta.url, "warn-ungrilled-plan", check);
