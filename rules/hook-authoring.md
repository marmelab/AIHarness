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

A field can also be present and mean something other than its name suggests. At
`SubagentStop`, `transcript_path` names the MAIN SESSION transcript, not the stopping
agent's. A sibling-meta lookup built on it therefore resolves nothing, and reading it for a
`MODE:` line, a `TASK_ID` or a final `APPROVED` answers with whatever happened FIRST in the
session. Identity and the agent's own transcript both come from `lib/agent-meta.mjs`, which
resolves them from the payload's `agent_id`; never re-derive either from `transcript_path`.

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
up: dozens of cycles over most of an hour on one ticket.

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

## The SubagentStop matchers do not filter, and one day they will

Every `SubagentStop` matcher in `hooks.json` currently selects nothing. The runtime sends
an EMPTY `agent_type` on that event, so the matcher has nothing to compare and every
registered SubagentStop hook fires on every stop, whatever role it names. That is why each
of those hooks re-derives identity itself, through `lib/agent-meta.mjs` and the predicates
in `lib/teams.mjs`, and treats "not my role" as "not my business".

So the matchers are not load-bearing today. They are DOCUMENTATION that happens to sit in a
field the runtime will start honouring. When it does, every one of them has to be re-audited
before it is trusted, because two of the ways they are written today would go from harmless
to silently wrong:

- **Namespaced roles.** A plugin-provided agent reports `aiharness:developer`, not
  `developer`. Every matcher token is bare. This is the same bug that made a whole family of
  guards inert once the harness shipped as a plugin (see `bareRole` in `lib/teams.mjs`); a
  matcher has no `bareRole` to go through.
- **Tokens that are not agents.** `simple-developer` is a declared role in
  `harness.config.json` and appears in the `validate-on-stop` matcher, but no agent is ever
  dispatched under that name: the SIMPLE flow dispatches `developer`. `check-config-sync`
  reports it, and the token will match nothing the day matching starts working.

Concretely, when a runtime upgrade makes `agent_type` non-empty at SubagentStop: check every
matcher against BOTH spellings of every role, drop the tokens no agent answers to, and only
then consider removing a hook's own identity check. Until then, never write a hook that
depends on its matcher having selected it: `hooks.json` says who a hook is FOR, the hook
itself decides whether the stop is its business.

## Log the identity you resolved

A guard that treats "not my role" as "not my business" is indistinguishable from a guard that
is broken. Log what you decided and on what basis, even when accepting, so
`grep '\[my-hook\]' hooks.log` answers "did it run, and what did it see". Absence of a line
must mean absence of a run, nothing else.

"On what basis" includes how sure you are. A line like `not orchestrator (unknown)` covers
two states at once: a resolved non-orchestrator, which is the guard working, and an identity
nobody could resolve, which is the guard off. `readAgentMeta` returns the `source` that
answered for exactly this reason: log it, and when identity is unresolvable say that instead
of naming a role you never read.
