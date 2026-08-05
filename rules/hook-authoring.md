---
paths:
  - "hooks/**"
---

# Writing a hook

The guards ARE the product. A guard that stops working reports nothing, so these rules exist
to make silent failure structurally hard. Every one comes from a defect found by running the
harness, never by reading it.

## Never decide on a payload field the runtime may omit

`run_in_background` is absent for a nested subagent. `agent_type` is empty. `agentType` from
the agent meta arrives namespaced (`aiharness:developer`). `last_assistant_message` is absent.

Requiring such a field breaks in one of two directions, both bad:

- **fail-closed** on absence and the guard is unsatisfiable. `force-foreground` demanded an
  explicit `run_in_background: false` and refused every pipeline dispatch: five `BLOCK` in four
  minutes, the harness unusable.
- **fail-open** on absence and the guard is off. `block-duplicate-dispatch` skipped when
  `run_in_background !== false`, so it skipped always: two planners twelve seconds apart with
  no log line. Every role predicate anchored on the bare role, so all of them returned false
  once the agents were namespaced, and a whole family of guards went quiet at once.

So: decide on what the field IS, not on what it is not. Block an explicit `true` rather than
requiring a `false`. Normalise identity through `bareRole` and the `teams.mjs` predicates,
never a literal `=== "orchestrator"`.

**Test all three states**: present-true, present-false, absent. A suite that only ever passes
the happy shape cannot see this class of break, which is exactly how it stayed hidden.

## Never constrain without a budget and an honest exit

An agent that cannot satisfy a guard must still be able to finish. The validation chain
refused a stop for as long as a step failed, with no budget and no way for the agent to give
up: 35 cycles over 52 minutes on one ticket.

Bound the refusals, then degrade in a way that keeps the invariant somewhere else:

- `completion-invariant` rejects twice, then writes a recovery marker and lets go.
- the uncommitted-work check rejects twice, then commits with an honest message rather than a
  `style(...)` one.
- the validation chain gives up after 5 failures per step and marks the ticket, and
  `block-merger-without-review` refuses the merge. "Never merge red" moves to the merge, where
  it can be enforced, instead of living in an unbounded refusal.

Say the budget out loud in the rejection (`attempt 2/5`), and warn on the last one, so an agent
repeating the same fix can report the failure instead.

## A guard's own state must not be able to lie

A marker means what it records, not what you hope it implies. `block-duplicate-dispatch`
treated "a planner was dispatched" as "a plan exists", so a planner lost to a transient API
error wedged planning with no tickets to show. Check the thing you actually care about.

## Two hooks that must agree share the predicate

`force-foreground` decides what to deny; `block-duplicate-dispatch` must debounce exactly what
proceeds. Each carried its own copy of the answer, they drifted, and the debounce switched
itself off. Shared predicates live in `lib/` (`isExplicitlyBackgrounded`, `bareRole`,
`reviewFlag`, `validationGaveUpFlag`).

## Mechanics that are checked, not trusted

`npm run check` fails on each of these, because each one is invisible at runtime:

- a registered hook must exist AND be executable. Claude Code runs it as a `command` through
  `/bin/sh`, so a `100644` hook dies with exit 126 in silence: `ensure-playwright-mcp` had
  never run once across eight sessions.
- every `SubagentStop` matcher must name a declared role.
- the core imports only node builtins and relative paths.

## Log the identity you resolved

A guard that treats "not my role" as "not my business" is indistinguishable from a guard that
is broken. Log what you decided and on what basis, even when accepting, so
`grep '\[my-hook\]' hooks.log` answers "did it run, and what did it see". Absence of a line
must mean absence of a run, nothing else.
