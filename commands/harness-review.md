---
description: Review a diff with the harness reviewer (code quality, security, over-engineering) without changing anything
---

Run the harness's own `quality-reviewer` against a diff and report what it found. **Read-only**: no worktree, no ticket, no branch, no commit, no fix. If the review finds something worth fixing, report it and stop — the user decides what happens next.

This is the review the pipeline runs on every ticket, made available on its own: Part A (spec-free code quality, reuse and minimization along the Ponytail ladder, TypeScript, tests) and Part B (the full security pass — RLS, secrets, injections, authn/authz, dependencies). One dispatch covers what would otherwise be three separate review passes.

1. **Resolve the target** from `$ARGUMENTS`, and say which one you picked before dispatching:
   - empty → the working tree against the repo's base branch: `git diff $(git merge-base HEAD <base>)...HEAD` plus uncommitted changes. Say so if the working tree is clean and there is nothing to review.
   - a branch name → `git diff $(git merge-base <branch> <base>)...<branch>`
   - a number, or `#<number>` → that pull request. Fetch its diff (`gh pr diff <n>`, or the GitHub MCP tools when `gh` is absent).
   - a path → the diff restricted to it; when the path has no pending changes, review the file as it stands and say that is what you did.
   - a git range (`a..b`, `a...b`) → used verbatim.

2. **Dispatch ONE reviewer, foreground**, and let it do the reading — do not pre-summarize the diff for it, and do not review it yourself first:

```
Agent({
  subagent_type: "aiharness:quality-reviewer",
  description: "Standalone review: <target in three words>",
  prompt: "ROLE: quality-reviewer\nMODE: review\nREVIEW_TARGET: <the resolved range, branch, PR or path>\nREPO: <absolute repo path>\n\nReview this diff per standalone review mode. Read-only: report, never edit. Text only, no SendMessage.",
  run_in_background: false
})
```

Keep `feature-review` out of the description: a hook reads that word as the end-of-feature pass and would launch the e2e suite on a session that has none.

3. **Relay the findings**, grouped by severity, with `file:line` links. Add nothing of your own beyond the target you resolved. If the user then asks for the fixes, that is a normal request — implement it directly, or through the harness with `#harness`, as usual.
