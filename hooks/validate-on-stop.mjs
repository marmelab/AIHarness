#!/usr/bin/env node
// SubagentStop: run the validation chain (format auto-fix, typecheck, lint, unit) on the
// worktree of the agent that just stopped. exit 2 keeps that subagent alive to fix and
// commit. e2e is NOT in this chain (end-of-feature only, launched by
// e2e-on-feature-review). VALIDATE_DRY_RUN=1 skips the chain; =fail simulates a failure.
//
// This hook fires on EVERY subagent stop (the SubagentStop matcher does not filter and
// `agent_type` in the payload is empty), so deciding whose stop it is IS the hook. A
// full-run audit of session 13afe5d3 measured what happens when it cannot:
//
//   212 chains ran for about 12 that were needed. 202 of them ran UNSCOPED, over every
//   session worktree, because identity was unresolvable and the code fell back to
//   wt=all. TASK-002 was re-validated 33 times, some chains 1.6 seconds apart, and was
//   still being validated 25 minutes after it was DONE.
//
// So there is no unscoped fallback any more. Three gates, in order, each accepting with a
// logged reason rather than sweeping something that is not ours:
//
//   1. Identity unresolvable  -> accept. lib/agent-meta.mjs has already logged one loud
//                                WARN for the session; there is nothing to attribute.
//   2. Not a validate role    -> accept. A reviewer, merger, planner or orchestrator owns
//                                no worktree, so its stop has nothing to validate.
//   3. No attributable worktree -> accept. A developer whose ticket cannot be recovered
//                                is not a licence to validate its siblings' work.
//
// Sweeping foreign worktrees is strictly worse than validating none: it re-runs work
// nobody asked for, and it applied the formatter's auto-commit to trees whose own
// developer was still mid-edit ("shared brakes", the exact failure the scoping was
// introduced to prevent).

import { existsSync, readFileSync } from "node:fs";
import { createHookContext } from "./lib/context.mjs";
import { git } from "./lib/git.mjs";
import {
  bareRole,
  getFirstTaskId,
  matchesRole,
  validateRoleSet,
} from "./lib/teams.mjs";
import { agentTranscriptPath, readAgentMeta } from "./lib/agent-meta.mjs";
import {
  sessionBranch,
  simpleWorktreePath,
  taskWorktreePath,
} from "./lib/topology.mjs";
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
  ctx.accept("identity unresolvable, nothing validated");
}

// --- gate 2: is validation this role's business --------------------------------------
const validateRoles = validateRoleSet();
if (!matchesRole(identity, validateRoles)) {
  ctx.accept(
    `skip: ${identity} stop (validation runs on ${[...validateRoles].join("/")})`,
  );
}

// --- gate 3: which worktree is theirs -----------------------------------------------
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
  ctx.fail(
    `Validation failed at step '${result.step}'. Fix the errors and commit before completing:\n` +
      result.output,
    { log: `step=${result.step}` },
  );
}

ctx.accept(result.skipReason || `OK (${ownWorktree})`);
