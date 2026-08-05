// Parse a PreToolUse(Agent) hook payload: the dispatch tool_input plus the
// `KEY: value` contract carried in the dispatch prompt (orchestrator STATE B
// templates). Every Agent-gating hook (setup-worktree, enforce-dev-dispatch,
// block-merger-without-review, block-promote-unmerged) parses through here, so
// the contract regexes live in exactly one place.
//
// TASK_ID is anchored at line start and only accepts TASK-<n> | SIMPLE | MIGRATION
// | PROMOTE | ROLLBACK, so prose mentioning another ticket (e.g. "TASK-001 is
// merged; now merge this one") can never mis-key a gate.

// Whether a dispatch is EXPLICITLY backgrounded, which is the only case
// force-foreground-orchestrator-dispatch denies. Absent is not the same thing: a nested
// subagent's Agent tool may not expose the parameter at all, so absent means "the runtime
// chose", not "the orchestrator chose background".
//
// It lives here because TWO hooks must agree on it. force-foreground decides what to deny;
// block-duplicate-dispatch decides what to debounce, and it must debounce exactly the
// dispatches that will proceed. When they disagreed, the debounce silently switched itself
// off for every pipeline role and a second planner got through.
export const isExplicitlyBackgrounded = (input) =>
  input?.tool_input?.run_in_background === true;

/**
 * @param {Record<string, unknown>} input  Parsed PreToolUse(Agent) payload.
 * @returns {object} Dispatch fields used by the Agent-gating hooks.
 */
export function parseDispatch(input) {
  const ti = (input && input.tool_input) || {};
  const prompt = String(ti.prompt ?? "");
  const grab = (re) => {
    const m = prompt.match(re);
    return m ? m[1] : "";
  };
  return {
    // "" for the main orchestrator; the agent's own type for a subagent-issued
    // dispatch (none of the ticket agents can dispatch, so this is informational).
    callerAgentType: String(input?.agent_type ?? ""),
    subagentType: String(ti.subagent_type ?? ""),
    name: String(ti.name ?? ""),
    isolation: String(ti.isolation ?? ""),
    runInBackground: Boolean(ti.run_in_background),
    role: grab(/^ROLE:\s*(\S+)/m),
    taskId: grab(/^TASK_ID:\s*(TASK-\d+|SIMPLE|MIGRATION|PROMOTE|ROLLBACK)\b/m),
    worktreePath: grab(/^WORKTREE_PATH:\s*(\S+)/m),
    branchName: grab(/^BRANCH_NAME:\s*(\S+)/m),
    mode: grab(/^MODE:\s*(\S+)/m),
    // STAGE: a-only marks a merger dispatch as Stage A ONLY (no Stage B / promotion),
    // even in SIMPLE / MIGRATION mode. Read by record-merger-stage to authorize promotion.
    stage: grab(/^STAGE:\s*(\S+)/m),
    sessionShortId: grab(/^SESSION_SHORT_ID:\s*(\S+)/m),
    ticketFile: grab(/^TICKET_FILE:\s*(\S+)/m),
    ticketsDir: grab(/^TICKETS_DIR:\s*(\S+)/m),
  };
}
