#!/usr/bin/env node
// PreToolUse(Agent): put every per-ticket review on the right model, by rewriting the
// dispatch rather than asking the orchestrator to remember.
//
// Per-ticket review is the largest single line of a run's cost. The rule itself is old and
// was written into orchestrator.md on 2026-08-07: pass `model: "sonnet"` for an ordinary
// ticket, omit `model` (so the agent file's `opus` applies) when the ticket touches
// `supabase/` or carries `schema_sensitive: true`.
//
// As a prompt instruction it did not hold. Measured over the nine benchmark runs that all
// postdate it: of 60 per-ticket reviewer dispatches, 16 passed `model: "sonnet"` and 44
// omitted the field, and 17 of those 44 were on tickets whose developer touched no
// `supabase/` file at all. Those Opus reviews cost $28.04; the same token usage at the
// Sonnet rate is $11.22. So the unenforced rule is worth up to $16.82 across nine runs,
// about a tenth of their $166 subagent bill. Upper bound, not a measurement: the ticket
// JSONs are long gone from /tmp, so some of the 17 may have legitimately carried
// `schema_sensitive: true`, which the rule sends to Opus on purpose.
//
// Rewriting beats refusing here. A refusal is right when only the caller can decide; this
// is a fact the harness can read off the ticket file, so spending an orchestrator turn to
// have the dispatch retyped would be pure waste.
//
// Two directions, and they are not symmetric:
//
//   ordinary ticket      -> SET model "sonnet"
//   schema-sensitive     -> REMOVE model, so the agent file's `opus` applies
//
// Removing rather than naming `opus` is deliberate and predates this hook: a runtime that
// ignores `model` then leaves the reviewer at its declared default, so the failure mode of
// the whole optimisation is spending too much, never reviewing too weakly.
//
// FAIL OPEN on ignorance, in the same direction: an unreadable or missing ticket file
// leaves the dispatch exactly as it came, which is the orchestrator's choice and usually
// Opus. A guard that cannot know must not guess the cheap answer.

import { readFileSync } from "node:fs";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { isQualityReviewer } from "./lib/teams.mjs";

// The reviews that judge the integrated feature or the migration. A miss there has nothing
// downstream to catch it, so they are never routed to the cheaper model.
const WHOLE_FEATURE_MODE =
  /^MODE:\s*(feature-review|feature-smoke|migration-review)/m;

/** Does this ticket's blast radius reach the database? */
export function isSchemaSensitive(ticket) {
  if (!ticket || typeof ticket !== "object") return null;
  if (ticket.schema_sensitive === true) return true;
  const files = Array.isArray(ticket.files_to_modify)
    ? ticket.files_to_modify
    : [];
  return files.some((f) => /(^|\/)supabase\//.test(String(f)));
}

export function check(input, ctx) {
  const d = parseDispatch(input);
  if (!isQualityReviewer(d.subagentType)) return;

  const prompt = String(input?.tool_input?.prompt ?? "");
  if (WHOLE_FEATURE_MODE.test(prompt))
    return ctx.allow("whole-feature or migration review: never downgraded");

  if (!d.ticketFile)
    return ctx.allow("no TICKET_FILE in the dispatch: left as dispatched");

  let ticket;
  try {
    ticket = JSON.parse(readFileSync(d.ticketFile, "utf8"));
  } catch {
    return ctx.allow(
      `ticket unreadable (${d.ticketFile}): left as dispatched, which keeps the stronger model`,
    );
  }

  const sensitive = isSchemaSensitive(ticket);
  if (sensitive === null)
    return ctx.allow("ticket is not an object: left as dispatched");

  const asked = input?.tool_input?.model;
  if (sensitive) {
    if (asked === undefined)
      return ctx.allow(
        `${d.taskId || "?"} schema-sensitive, already on the default`,
      );
    return ctx.rewriteInput(
      { model: undefined },
      { log: `${d.taskId || "?"} schema-sensitive: dropped model=${asked}` },
    );
  }
  if (asked === "sonnet")
    return ctx.allow(`${d.taskId || "?"} ordinary, already on sonnet`);
  return ctx.rewriteInput(
    { model: "sonnet" },
    {
      log: `${d.taskId || "?"} ordinary ticket: model=${asked ?? "(absent)"} -> sonnet`,
    },
  );
}

runStandalone(import.meta.url, "route-review-model", check);
