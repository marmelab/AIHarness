#!/usr/bin/env node
// PreToolUse(Agent) - force the orchestrator's pipeline dispatches to run FOREGROUND.
//
// Root cause (transcript forensics + a probe): the VS Code extension defaults the Agent
// tool to BACKGROUND, and a nested subagent (the orchestrator, spawnDepth >= 1) is NEVER
// re-invoked when a background child completes. So a background dispatch from the
// orchestrator ends its turn "to await a notification" that never comes - review / merge /
// promotion never run and finished dev work is orphaned.
// A probe confirmed explicit run_in_background:false DOES block (child output inline) while
// the default is async; CLI defaults to foreground, so the bug only ever bit the extension.
//
// Enforcement (the prose guard in orchestrator.md was ignored): DENY any orchestrator->child
// pipeline dispatch that is EXPLICITLY backgrounded. Detection is by the CHILD role - only
// the orchestrator dispatches these - so main->orchestrator (child=orchestrator) and the
// fire-and-forget documentator are never touched. Fail-open: any error or unrecognized shape
// allows the dispatch.
//
// It used to deny anything that was not an explicit false, which wedged the harness in a
// runtime that does not expose the parameter to a nested subagent at all. See the long note
// at the decision itself for why absent is now accepted and what covers the gap.

import { readFileSync } from "node:fs";
import { createHookContext } from "./lib/context.mjs";
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

let input;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // no / unparseable payload -> allow
}

const ctx = createHookContext(input, "force-foreground-orchestrator-dispatch");

try {
  const d = parseDispatch(input);
  const childRole = PIPELINE_ROLES.has(d.subagentType)
    ? d.subagentType
    : PIPELINE_ROLES.has(d.role)
      ? d.role
      : "";

  // Not an orchestrator->pipeline-child dispatch -> none of our business.
  if (!childRole) ctx.accept("not a pipeline dispatch");

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
  // What still catches the original bug: an EXPLICIT true. A runtime that exposes the
  // parameter lets the orchestrator choose, orchestrator.md tells it to choose false, and
  // choosing true for a pipeline child is always wrong, so that stays blocked.
  //
  // What covers the residual risk in the absent case: completion-invariant.mjs, which
  // rejects the orchestrator's stop when APPROVED work is left unmerged and then hands off
  // to a recovery run. That backstop is why relaxing here is acceptable now and was not
  // before: it had been silently inert (it looked for verdict flags in a directory that
  // never existed) until it was fixed and given tests.
  const rib = input.tool_input?.run_in_background;
  // Shared with block-duplicate-dispatch, which must debounce exactly what proceeds here.
  if (!isExplicitlyBackgrounded(input)) {
    ctx.accept(
      rib === false
        ? `${childRole} foreground (explicit false)`
        : `${childRole} accepted (runtime exposes no run_in_background)`,
    );
  }

  ctx.block({
    reason:
      `Nested orchestrator dispatch of "${childRole}" must not be EXPLICITLY backgrounded. A ` +
      `nested subagent is never re-invoked when a background child completes, so this ` +
      `dispatch would orphan the pipeline (review/merge/promotion never run). Re-dispatch with ` +
      `run_in_background: false - verified to block and return the child's result inline in ` +
      `this runtime.`,
    log: `blocked ${childRole} rib=${rib === undefined ? "absent" : String(rib)}`,
  });
} catch (e) {
  // Never let this gate break a real dispatch.
  ctx.log(`error, allowing: ${String(e).slice(0, 120)}`);
  process.exit(0);
}
