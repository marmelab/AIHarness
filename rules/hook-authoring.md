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

## The SubagentStop matchers are honoured, so they must never name a role

A `SubagentStop` matcher is compared against the payload's `agent_type`, and it decides
whether the hook process is spawned at all. MEASURED under Claude Code 2.1.227, with one
probe hook group per matcher shape:

| `agent_type` | `"planner"` | `"developer\|planner"` | `".*"` | `"*"` | omitted | `"(x:)?planner"` |
|---|---|---|---|---|---|---|
| `planner` | fires | fires | fires | fires | fires | fires |
| `xplanner` | — | — | fires | fires | fires | fires |

So a matcher of plain alphanumerics + `|,-_` is an EXACT match against the `|`-separated
list, and a matcher containing a regex metacharacter is an UNANCHORED `RegExp`.

**A bare role token therefore cannot match a plugin install's `agent_type`**, which arrives
NAMESPACED (`aiharness:quality-reviewer`). That one line cost three audits and every
plugin-only run the harness has ever made: with matchers reading `quality-reviewer`,
`developer|…`, `merger`, `orchestrator`, not one SubagentStop hook was spawned on any real
stop. No review verdict was recorded, so `block-merger-without-review` refused every merge;
no validation ran, so typecheck, lint and the unit suite executed zero times in a 39-minute
session; `cleanup-worktree` never swept; `completion-invariant` never saw the orchestrator.

Nothing failed loudly, and the reason it stayed hidden for so long is worth naming: the
runtime ALSO fires a book-keeping stop every ~32 s that carries no `agent_type` at all.
An absent value defeats no matcher, so every hook DID run on those — and they were the only
stops the hooks ever saw. `hooks.log` was therefore full of `not a harness agent (unnamed)`
lines and empty of real ones, which reads exactly like "the runtime never sends a real stop"
and was written up as such twice.

The rule, then:

- **A SubagentStop matcher must be `".*"`.** It selects every agent whatever its namespace
  or suffix, and the hook decides for itself whether the stop is its business — through
  `lib/agent-meta.mjs` and the `bareRole`-based predicates in `lib/teams.mjs`, which already
  handle `developer`, `aiharness:developer` and `developer-TASK-001` alike. `hooks.json`
  cannot do that comparison; only the hook can.
- **A hook that runs on every stop must be safe on every stop.** Not merely quiet: a stop it
  does not own must not be able to make it act. `record-review-verdict` takes the ROLE from
  identity alone for exactly this reason — it used to recover the role by scanning the
  stopping agent's transcript for `ROLE: quality-reviewer`, and the ORCHESTRATOR's transcript
  contains the reviewer dispatch prompts it wrote, so a summary mentioning APPROVED could
  have written the flag that gates the merge.
- `check-config-sync` reports any SubagentStop matcher that filters by role, and
  `hooks/test/subagent-stop-matchers.test.mjs` fails if one reappears in this repo's wiring.
- A project that VENDORED the harness under `.claude/` with its own bare-named agents does
  match on bare tokens, which is why the report is a NOTE and not an error. It still breaks
  the day that project enables the plugin.

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
