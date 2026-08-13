#!/usr/bin/env node
// SubagentStop: run the validation chain (format auto-fix, typecheck, lint, unit) on the
// worktree of the agent that just stopped. exit 2 keeps that subagent alive to fix and
// commit. e2e is NOT in this chain (end-of-feature only, launched by
// e2e-on-feature-review). VALIDATE_DRY_RUN=1 skips the chain; =fail simulates a failure.
//
// This hook fires on EVERY subagent stop (the SubagentStop matcher does not filter and
// `agent_type` in the payload is empty), so deciding whose stop it is IS the hook. Four
// gates, in order, each accepting with a logged reason:
//
//   1. Identity unresolvable  -> accept. lib/agent-meta.mjs has already logged one loud
//                                WARN for the session; there is nothing to attribute.
//   2. Not a validate role    -> accept. A reviewer, merger, planner or orchestrator owns
//                                no worktree, so its stop has nothing to validate.
//   3. Mid-turn stop          -> accept. A stop is not a finish: the runtime fires this
//                                event on turn breaks too. See lib/contract-line.mjs.
//   4. No attributable worktree -> accept. A developer whose ticket cannot be recovered
//                                is not a licence to validate its siblings' work.
//
// There is no unscoped fallback. Sweeping every session worktree is strictly worse than
// validating none: it re-runs work nobody asked for, and it applies the formatter's
// auto-commit to trees whose own developer is still mid-edit (the "shared brakes" failure
// this scoping exists to prevent).

import { existsSync, readFileSync } from "node:fs";
import { createHookContext } from "./lib/context.mjs";
import { git } from "./lib/git.mjs";
import {
  bareRole,
  getFirstTaskId,
  matchesRole,
  validateRoleSet,
} from "./lib/teams.mjs";
import {
  agentTranscriptPath,
  isPhantomStop,
  readAgentMeta,
} from "./lib/agent-meta.mjs";
import { turnState } from "./lib/contract-line.mjs";
import {
  sessionBranch,
  simpleWorktreePath,
  taskWorktreePath,
} from "./lib/topology.mjs";
import { forLog } from "./lib/log-output.mjs";
import { runValidationSteps } from "./lib/validation.mjs";

const raw = readFileSync(0, "utf8");
const ctx = createHookContext(raw, "validate");
let payload = {};
try {
  payload = JSON.parse(raw);
} catch {
  payload = {};
}

// --- gate 1: who stopped ------------------------------------------------------------
// Mirrors cleanup-worktree: the payload's own identity fields when the runtime fills
// them, else the spawn meta resolved by lib/agent-meta.mjs.
const meta = readAgentMeta(payload);
const identity =
  [ctx.agentName, ctx.agentType, meta && meta.agentType].find(Boolean) || "";
if (!identity) {
  ctx.accept(
    isPhantomStop(payload)
      ? "not a harness agent (no transcript, no meta, unnamed), nothing validated"
      : "identity unresolvable, nothing validated",
  );
}

// --- gate 2: is validation this role's business --------------------------------------
// Once per role, then counted in <sessionDir>/skips/: with the `.*` matcher this hook runs on
// every stop of every agent, so repeating this line spends most of the log saying validation
// was not the stopping role's business.
const validateRoles = validateRoleSet();
if (!matchesRole(identity, validateRoles)) {
  ctx.acceptOnce(
    `validate-skip-role:${bareRole(identity)}`,
    `skip: ${identity} stop (validation runs on ${[...validateRoles].join("/")})`,
  );
}

// --- gate 3: did this agent finish, or is it between turns? --------------------------
// The chain is the developer's stop contract: it runs when the developer says it is done,
// rejects the stop on a failure, and hands back the errors. Running it on a turn break
// instead makes it a periodic interrupt of work in progress. That is what one run
// measured: 78 chains for ~13 dispatches, 21 rejections of "uncommitted work" against
// trees whose developer was still editing, and 8 force-commits of that work by the
// format step, two of which reached the session branch as `chore(TASK-XXX): commit work
// the agent left uncommitted`.
//
// `unknown` (no readable last message) runs the chain, exactly as before: not being able
// to look is not evidence of a turn break, and skipping validation on a doubt is the one
// outcome worse than running it too often.
const state = turnState(payload, identity);
if (state === "mid-turn") {
  ctx.acceptOnce(
    `validate-skip-midturn:${bareRole(identity)}`,
    `skip: ${identity} stopped mid-turn (no ${bareRole(identity)} contract line in its last message), nothing validated`,
  );
}

// --- gate 4: which worktree is theirs -----------------------------------------------
// A per-ticket developer validates <base>/TASK-XXX; a single-shot developer on the
// <short>/simple branch (rollback / migration) validates <base>/simple.
const ids = [ctx.agentName, ctx.agentType].filter(Boolean);
let taskId = ids.map(getFirstTaskId).find(Boolean) || "";
// The simple-developer ROLE names its worktree on its own. A plain `developer` can also
// be dispatched onto /simple (the e2e-fix flow does exactly that), which is what the
// BRANCH_NAME scan below is for.
let isSimple = bareRole(identity).startsWith("simple-developer");

// The dispatch description carries the ticket ("Implement TASK-002: ...").
if (!taskId && meta) {
  const m = meta.description.match(/TASK-\d+/);
  if (m) taskId = m[0];
}

// Last resort: the dispatch contract at the top of the agent's OWN transcript. Resolved
// through agentTranscriptPath, never the payload's transcript_path: that names the MAIN
// session transcript, which carries every dispatch of the session, so scanning it
// attributes the FIRST ticket dispatched to whoever happens to stop.
if (!taskId && !isSimple) {
  const tp = agentTranscriptPath(payload);
  if (tp && existsSync(tp)) {
    try {
      for (const line of readFileSync(tp, "utf8").split("\n")) {
        const m =
          line.match(/TASK_ID[:=\s]+(TASK-\d+)/) ||
          line.match(/TICKET_FILE[=:\s]+\S*(TASK-\d+)/);
        if (m) {
          taskId = m[1];
          break;
        }
        if (/BRANCH_NAME[:=\s]+\S+\/simple\b/.test(line)) isSimple = true;
      }
    } catch {
      // best-effort: gate 3 below accepts when nothing was attributable
    }
  }
}

const ownWorktree = taskId
  ? taskWorktreePath(ctx, taskId)
  : isSimple
    ? simpleWorktreePath(ctx)
    : "";

if (!ownWorktree) {
  ctx.accept(
    `no worktree attributable to ${identity} (identity via ${meta ? meta.source : "payload"}), nothing validated`,
  );
}

// Diff the worktree against session/<short>, not the repo's checked-out base branch, so
// validation sees this ticket's OWN change set. (A single-shot simple developer is the
// exception: resolving-rollback-conflicts does `git reset --hard <BASE_BRANCH>`,
// re-forking <short>/simple onto the default branch, so its diff against
// session/<short> can span unrelated files. Accepted noise, since the rollback's whole
// point is to diverge from the session.) Empty base -> validation.mjs falls back to the
// repo base branch (e.g. before the session branch exists).
const sessionRef = sessionBranch(ctx);
const base =
  git(["show-ref", "--verify", "--quiet", `refs/heads/${sessionRef}`])
    .status === 0
    ? sessionRef
    : "";

ctx.log(
  `START role=${identity} wt=${ownWorktree} base=${base || "repo-default"} MODE=${process.env.MODE || ""}`,
);

const result = runValidationSteps(ctx, {
  worktree: ownWorktree,
  base,
  // The worktree this stop OWNS. validation.mjs refuses to consume a dirty-work budget
  // or to commit anything in a worktree that is not it.
  owner: ownWorktree,
});

if (!result.ok) {
  // The ONE line that says FAIL for this stop, and the only place the captured output
  // reaches the log: stripped of ANSI escapes, bounded, and prefixed line by line. The
  // agent still gets it verbatim on stderr, which is the channel it is written for.
  const captured = forLog(result.output);
  ctx.fail(
    `Validation failed at step '${result.step}'. Fix the errors and commit before completing:\n` +
      result.output,
    {
      log:
        `step=${result.step} wt=${ownWorktree}` +
        (captured ? `\n${captured}` : ""),
    },
  );
}

ctx.accept(result.skipReason || `OK (${ownWorktree})`);
