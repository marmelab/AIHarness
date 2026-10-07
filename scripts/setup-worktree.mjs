#!/usr/bin/env node
// Create this ticket's worktree, from the developer itself.
//
//   node scripts/setup-worktree.mjs --task TASK-001
//   node scripts/setup-worktree.mjs --simple
//
// The same code the PreToolUse(Agent) hook runs, reached the other way. A developer
// dispatched by a workflow gets no hook: a workflow's `agent()` is not an Agent tool
// call, so PreToolUse(Agent) never fires and none of the twelve dispatch guards run.
// Measured on a probe run, where the parent saw one PreToolUse(Workflow) for the launch
// and nothing at all per dispatch.
//
// Calling it is therefore safe on BOTH paths and required on one. The underlying code
// adopts an already-registered worktree instead of recreating it, so a developer
// dispatched the usual way finds the hook has already been here and this is a no-op.
//
// Native `isolation: 'worktree'` does not replace this. It names the worktree and branch
// itself, forks from HEAD rather than the session integration branch, provisions no
// dependencies, and creates neither the `_session` worktree nor the `session-base`
// anchor. The merger, the promotion and `completion-invariant` all read the names
// topology.mjs computes, so a runtime-chosen name breaks everything downstream.

import { createHookContext } from "../hooks/lib/context.mjs";
import { setupTaskWorktree } from "../hooks/lib/worktree-setup.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const taskId = value("task");
if (!taskId && !flag("simple")) {
  console.error(
    "usage: setup-worktree.mjs --task TASK-001 | --simple\n" +
      "  Creates (or adopts) this ticket's git worktree, forked from the session\n" +
      "  integration branch and provisioned. Safe to run twice.",
  );
  process.exit(2);
}

if (taskId && !/^TASK-\d+$/.test(taskId)) {
  console.error(`setup-worktree: \`${taskId}\` is not a TASK-NNN id`);
  process.exit(2);
}

// The hook gets its identity from the dispatch payload; here it comes from the
// environment the developer is already running in.
const ctx = createHookContext(
  { session_id: process.env.CLAUDE_CODE_SESSION_ID || "" },
  "setup-worktree",
);

// The shape `setupTaskWorktree` reads, built from argv rather than from a dispatch.
// `branchName` is what tells it a task-less developer is the shared /simple one.
const dispatch = {
  subagentType: "developer",
  taskId: taskId || "",
  name: taskId ? `developer-${taskId}` : "developer",
  branchName: taskId ? "" : `${ctx.sessionShort}/simple`,
  worktreePath: "",
  role: "developer",
  mode: "",
};

let result;
try {
  result = setupTaskWorktree(ctx, dispatch);
} catch (e) {
  console.error(`setup-worktree: ${e.message}`);
  process.exit(1);
}

if (result.skip) {
  console.error(`setup-worktree: ${result.detail}`);
  process.exit(1);
}

if (!result.ok) {
  console.error(`setup-worktree: ${result.reason}`);
  process.exit(1);
}

// The path is the one thing the caller needs back: it is where the developer works.
console.log(result.detail);
if (result.worktreePath) console.log(`WORKTREE_PATH: ${result.worktreePath}`);
if (result.branchName) console.log(`BRANCH_NAME: ${result.branchName}`);
