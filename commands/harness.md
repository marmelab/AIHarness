---
description: Run a change through the agent harness, asking for the level and the gate instead of making you remember them
---

Route a code-change request through the harness orchestrator, after asking the two questions whose answers the dispatch needs. This is the same thing as typing `#harness`, minus having to remember `level=` and `gate=`.

**The request itself is `$ARGUMENTS`.** If it is empty, ask what to build first (one `AskUserQuestion`, free-text), and stop if the answer is empty.

### 1. Scope it before asking anything

Run `Skill({skill: "grill-me"})` on the request. It decides for itself whether it needs to question you and exits in a line when the scope is already precise. Fold its answers into the dispatch prompt. Do this FIRST: the answers can change which level is the right one.

### 2. Ask, in ONE `AskUserQuestion` call (two questions, or three when the level is `feature`)

**Question 1 — "What kind of change is this?"**, header `Level`:

| Option                                                  | Description to show                                                                  |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `Bugfix` (put first when the request reads as a defect) | A known defect. One developer, no planner, no wave.                                  |
| `Small change` (put first otherwise)                    | A contained change on existing surfaces: a field, a label, a filter, a column.       |
| `Feature`                                               | New surface, several entities, or work that needs a plan before code. Full pipeline. |
| `Review only`                                           | Nothing is changed: run the reviewer over a diff and report.                         |

`Review only` ends the flow here — hand off to `/harness-review` with the request as its target and do not dispatch an orchestrator.

**Question 2 — "Where should it stop for you?"**, header `Gate`:

| Option                                 | Description to show                                                                             |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `Review the plan` (recommended, first) | Pauses after planning so you can read the real tickets, and again before touching the database. |
| `Database only`                        | No plan pause; still stops before applying a database migration.                                |
| `Every wave`                           | Pauses after planning, after each wave of tickets, and before the database.                     |
| `Don't stop`                           | Fully autonomous, migration included. For an overnight or throwaway run.                        |

Map them to `GATE: plan | migration | waves | none`. For `bugfix` and `small`, only the plan gate is moot (there is no plan) — ask anyway: the migration stop is the one that matters there.

**Question 3, only when the level is `Feature`** — "Who is this run for?", header `Report`: `Developer` (→ `PERSONA: technical`: file paths, TASK ids, branches, SHAs, stops on the session branch without promoting, writes `harness-progress.log`) or `Plain language` (no persona line). Skip the question for `bugfix`/`small` and default to `PERSONA: technical` on a developer surface.

### 3. Dispatch

One `orchestrator`, with the answers on their own lines. Never implement the request yourself, and never re-dispatch while one is running:

```
Agent({
  subagent_type: "aiharness:orchestrator",
  description: "<the request in five words>",
  prompt: "<the request, verbatim, plus grill-me's answers>\n\nLEVEL: <bugfix|small|feature>\nGATE: <none|migration|plan|waves>\n<PERSONA: technical, when chosen>\n<session_dir>: <this session's dir>",
  run_in_background: true
})
```

Then follow the harness rules already in CLAUDE.md: surface progress while it runs (the status board once planning has produced one, or a `Monitor` on `harness-progress.log`), relay the plan gate by reading the ticket JSONs inline, and relay the final report when the task-notification arrives. An async "Agent launched" acknowledgement means dispatched, not finished.

### 4. Grill the plan before relaying it

When the orchestrator stops at the plan gate (every `GATE` but `none`), run
`Skill({skill: "plan-grill"})` with this session's `TICKETS_DIR` (`<session_dir>/tickets`)
BEFORE you ask for the approval, then relay the tickets as the skill left them: it folds the
answers back into the ticket JSONs, so reading them after it returns is reading the plan the
user actually approved.

Invoke it unconditionally. It asks only about what the planner marked `derived` or listed in
`open_questions`, and hands back in one line when there is none of either, so there is no
condition for you to evaluate first. One hand-back is NOT an all-clear: when it reports that
it found no ticket file, the plan was not grilled at all, so relay that as the warning it is
and find where the orchestrator actually wrote the tickets before you ask for an approval. It runs in the MAIN thread, never in a subagent: an
agent that asks a question ends its turn, and the answer reaches a fresh agent with no
memory of asking.
