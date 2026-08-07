#!/usr/bin/env node
// PreToolUse(Agent) - force the orchestrator's pipeline dispatches to run FOREGROUND.
//
// A foreground dispatch returns the child's contract line inline, which is the shape the
// orchestrator's stage barriers are written against. An explicitly BACKGROUNDED pipeline
// dispatch is denied: where the runtime lets the caller choose, choosing background for a
// child whose result the next step needs is always wrong.
//
// Detection is by the CHILD role - only the orchestrator dispatches these - so
// main->orchestrator (child=orchestrator) and the fire-and-forget documentator are never
// touched. Fail-open: any error or unrecognized shape allows the dispatch.
//
// ABSENT is accepted. A nested subagent's Agent tool does not expose the parameter in every
// runtime, and requiring an explicit false there made every pipeline dispatch impossible.
// See the long note at the decision itself. In such a runtime this hook has nothing left to
// deny, so it says so ONCE per session rather than on every dispatch: dozens of identical
// ACCEPT lines bury the log lines that mean something.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runStandalone } from "./lib/hook-chain.mjs";
import {
  isExplicitlyBackgrounded,
  parseDispatch,
} from "./lib/dispatch-parse.mjs";
import { pipelineRoleSet } from "./lib/teams.mjs";

// Pipeline roles whose result the orchestrator MUST consume in the same turn come
// from harness.config.json (config.roles `pipeline` flag), so this set and the
// one in block-duplicate-dispatch share one source. The orchestrator
// (main->orchestrator hop) and documentator (fire-and-forget) are excluded
// (pipeline:false): their background dispatch is correct.
const PIPELINE_ROLES = pipelineRoleSet();

export function check(input, ctx) {
  try {
    const d = parseDispatch(input);
    const childRole = PIPELINE_ROLES.has(d.subagentType)
      ? d.subagentType
      : PIPELINE_ROLES.has(d.role)
        ? d.role
        : "";

    // Not an orchestrator->pipeline-child dispatch -> none of our business.
    if (!childRole) return ctx.allow("not a pipeline dispatch");

  // Read run_in_background RAW: parseDispatch coerces absent->false, and the three cases
  // are genuinely different here.
  //
  // ABSENT is ACCEPTED, and that is a correction. Requiring an explicit false deadlocked
  // the harness in a runtime where a nested subagent's Agent tool does not expose the
  // parameter at all (schema: description, isolation, model, prompt, subagent_type, with
  // additionalProperties:false). The orchestrator then cannot comply no matter what it
  // does: observed as five consecutive `BLOCK blocked developer rib=absent` over four
  // minutes, with every pipeline dispatch impossible. A guard that cannot be satisfied is
  // not protection, it is a wedge.
  //
  // What still fires: an EXPLICIT true. A runtime that exposes the parameter lets the
  // orchestrator choose, orchestrator.md tells it to choose false, and choosing true for a
  // pipeline child is always wrong, so that stays blocked.
  //
  // What covers the residual risk in the absent case: completion-invariant.mjs, which
  // rejects the orchestrator's stop when APPROVED work is left unmerged and then hands off
  // to a recovery run. That backstop is why relaxing here is acceptable now and was not
  // before: it had been silently inert (it looked for verdict flags in a directory that
  // never existed) until it was fixed and given tests.
    const rib = input.tool_input?.run_in_background;
    // Shared with block-duplicate-dispatch, which must debounce exactly what proceeds here.
    if (!isExplicitlyBackgrounded(input)) {
      if (rib === false)
        return ctx.allow(`${childRole} foreground (explicit false)`);
      // The parameter is absent, so this guard cannot fire in this runtime at all. Worth
      // knowing once; worth nothing repeated per dispatch.
      if (noteInertnessOnce(ctx))
        return ctx.allow(
          `${childRole} accepted: this runtime exposes no run_in_background to a nested subagent, ` +
            `so this guard is inert for the rest of the session. A background dispatch here is ` +
            `not a dead end: the orchestrator IS re-woken by the child's task-notification.`,
        );
      return;
    }

    ctx.block({
      reason:
        `Nested orchestrator dispatch of "${childRole}" must not be EXPLICITLY backgrounded. The ` +
        `next step needs this child's contract line, and a foreground call returns it inline. ` +
        `Re-dispatch with run_in_background: false.`,
      log: `blocked ${childRole} rib=${rib === undefined ? "absent" : String(rib)}`,
    });
  } catch (e) {
    // Never let this gate break a real dispatch.
    ctx.log(`error, allowing: ${String(e).slice(0, 120)}`);
  }
}

runStandalone(import.meta.url, "force-foreground-orchestrator-dispatch", check);

// True the first time it is called in a session, false afterwards. A sentinel file rather
// than a counter: the point is one line in the log, and the exact number of inert dispatches
// is not information anyone acts on.
function noteInertnessOnce(ctx) {
  const sentinel = join(ctx.sessionDir, "force-foreground-inert");
  try {
    if (existsSync(sentinel)) return false;
    mkdirSync(ctx.sessionDir, { recursive: true });
    writeFileSync(sentinel, "");
    return true;
  } catch {
    return false; // cannot record it -> stay quiet rather than log on every dispatch
  }
}
