#!/usr/bin/env node
// PreToolUse(Agent): set the per-ticket review model from the ticket, by rewriting the
// dispatch rather than asking the orchestrator to remember the rule.
//
// Two directions, and they are NOT symmetric:
//
//   ordinary ticket   -> SET model "sonnet"
//   schema-sensitive  -> REMOVE model, so the agent file's `opus` applies
//
// Removing rather than naming `opus` is load-bearing: a runtime that ignores `model` then
// leaves the reviewer on its declared default, so the failure mode of the optimisation is
// spending too much, never reviewing too weakly. Fail-open goes the same way: anything
// unreadable leaves the dispatch as dispatched, which is usually opus.

import { readFileSync } from "node:fs";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { isQualityReviewer } from "./lib/teams.mjs";

// A miss in these has nothing downstream to catch it, so they are never downgraded.
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
