#!/usr/bin/env node
// PreToolUse(Agent) — before a developer subagent starts, create its git worktree and
// provision node_modules. Fires on the orchestrator's Agent dispatch, where the
// dispatched identity (subagent_type, name, prompt) is available — unlike SubagentStart,
// which in a parallel wave cannot tell which of N developers is starting, so it cannot
// know the TASK_ID / worktree to create.
//
// The work itself lives in lib/worktree-setup.mjs, because a workflow's `agent()` is not
// an Agent tool call and this hook never fires for one. scripts/setup-worktree.mjs is the
// other caller, which a developer runs for itself.

import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { setupTaskWorktree } from "./lib/worktree-setup.mjs";

export function check(input, ctx) {
  const r = setupTaskWorktree(ctx, parseDispatch(input));
  if (r.skip) return;
  if (r.ok) return ctx.allow(r.detail);
  ctx.fail(r.reason, r.log ? { log: r.log } : undefined);
}

runStandalone(import.meta.url, "setup-worktree", check);
