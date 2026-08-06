---
paths: []
---

# Validation commands: DO NOT RUN

Validation is automated and config-driven. The steps live in ONE place,
`harness.config.json` -> `validation.steps`, consumed by both the runner and the
guard, so they can never drift:

- `validate-on-stop.mjs` (SubagentStop) runs the whole chain after every
  developer / simple-developer / test-writer stop: the format step (prettier auto-fix +
  commit), typecheck, lint (eslint, scoped to the stop's changed files) and the unit steps.
  A failed step rejects the stop; the agent's internal loop fixes it and only a
  green stop returns control to the orchestrator.
  **e2e is NOT in this chain**: a ticket can legitimately be mid-feature, and the
  chain's `cwd:"repo"` steps run in the base-branch checkout, so a per-stop e2e run
  only ever tested code the ticket had not touched.
- **The chain only ever touches the stopping agent's OWN worktree.** It fires on every
  subagent stop (the matcher does not filter and `agent_type` is empty), so it resolves who
  stopped, checks that the role is one that owns a worktree (`roles.<role>.validate` in the
  config), and attributes exactly one worktree. Any of those three failing means it
  validates NOTHING and says so in `hooks.log`. There is no "validate everything" fallback:
  one audited run made 212 chains for about 12 that were needed, 202 of them unscoped, and
  the sweep applied the formatter's auto-commit to trees whose own developer was still
  mid-edit. A worktree whose state is unchanged since the last green chain is skipped, and
  one already being validated by a concurrent chain is skipped.
- **A refusal is bounded and, for now, ADVISORY.** The reject-fix loop above is what the
  harness intends; it has not been verified that the runtime delivers a rejection into the
  stopping subagent's context (in one audited run the feedback reached none of 10 developer
  transcripts). So no invariant depends on an agent reacting to a refusal: every refusal has
  a budget and an honest exit, and "never merge red" is enforced at the merge instead. See
  `hooks/test/validation-feedback-path.test.mjs` for the manual check that would settle it.
- **The chain has a failure budget.** A step that fails rejects the stop, and the agent's loop
  fixes it and stops again, but only up to 5 consecutive failures for that step. Past it the
  stop is RELEASED rather than refused forever, a marker lands in
  `<session_dir>/validation-gave-up/<TASK-XXX>`, and `block-merger-without-review` then refuses
  to merge that ticket. So "we never merge red" is enforced at the merge, not by an unbounded
  refusal: an agent that cannot reach green stops the ticket instead of wedging the pipeline.
  The penultimate rejection says so explicitly, so an agent that is repeating the same fix can
  report the failure in its final message instead.
- `e2e-on-feature-review.mjs` (SubagentStop, `quality-reviewer`) is the ONLY place
  the e2e suite is launched. It fires on the `MODE: feature-review` stop, and only
  when that review APPROVED (it keys off the reviewer's own
  `FEATURE-quality-reviewer` flag, not a transcript read), then runs
  `.claude/scripts/e2e-smoke.sh` on the integrated `_session` worktree with an
  isolated slot-leased Supabase. The outcome lands in
  `<session_dir>/e2e-result.json` for the orchestrator to read. **No agent launches
  the suite, the orchestrator included**, and `bash-guard` enforces that for every
  caller. A stale result from an earlier round is dropped as soon as a feature review
  stops, so a missing file means "not run this round", never "passed earlier".
- `completion-invariant.mjs` (SubagentStop, `orchestrator`) is the backstop on the
  other end: reading that result is a prompt-level instruction, so stopping while it
  says `failed` gets the stop rejected once. Then it is allowed through, on its own
  budget and with no recovery marker, because a red suite is not an orphaned pipeline
  and "never wedge the pipeline" still holds.
- `bash-guard.mjs` (PreToolUse Bash) blocks `developer` / `quality-reviewer` from
  running those same commands manually, plus `validation.extraForbidden` (build,
  e2e). The forbidden set is DERIVED from `validation.steps`, not hardcoded here.

## Why blocked (developer / quality-reviewer)

- Burns tool budget: each manual call the hook already runs is wasted.
- Can hang: `npx vitest` launches a headed Chromium; without a display it waits
  forever. The hooks set `CI=true` to force `chromium-headless-shell`; manual
  calls do not.
- Duplicates hook work: the validation hooks already run these; failures come back
  on stderr.

To change what runs (or what is forbidden), edit `harness.config.json`, never a
command string in a hook or in this file.

## What to do instead

- **Developer / test-writer**: after implementation + commit, stop. The hooks
  run and inject any failures via stderr. Fix and commit again next turn. Do not
  run the merge yourself: that is the merger's job. **Never end a turn with a dirty
  tree**: `git status --porcelain` must be empty before you stop, or the chain commits your
  work for you under a message you did not write (`agents/developer.md`, END OF TURN).
- **Reviewers**: focus on what hooks can't check (semantic review, integration
  wiring, e2e spec presence). To verify TypeScript, `Read` the source, do not run
  the compiler.

## When a human asks you directly to run one of these

Say plainly that it is not yours to run, and give the two real options:

- they run it themselves with a user-typed `!` command. `PreToolUse` hooks do not fire on
  those, by design: the guard gates agents, not the person at the keyboard.
- or, for e2e specifically, the change goes through the harness (`#harness`) and the
  end-of-feature hook runs the suite on the integrated session worktree, writing
  `<session_dir>/e2e-result.json`.

**Never offer to bypass, disable or work around a harness guard, and never suggest the
human could authorize you to.** It is not a permission question: a `PreToolUse` deny blocks
the call whatever anyone says, so the offer is both wrong and impossible, and making it
teaches the human that the guard is negotiable. If you believe a guard is wrong, name it,
say why, and leave the decision to a change in `harness.config.json` or in the plugin,
where it is reviewable.

This holds for every guard, not just validation: a blocked merge, a blocked container, a
missing review verdict. The answer is always "here is what I can do instead", never "let me
around it".
