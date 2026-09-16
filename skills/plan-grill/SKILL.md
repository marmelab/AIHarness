---
name: plan-grill
description: Question what the planner had to invent, at the harness plan gate. Load in the MAIN thread once the planner has written its tickets and before the coordinator asks for approval. Never inside a subagent, never before a plan exists.
---

# plan-grill

Ask about what the planner guessed, and about nothing else. A plan that invented nothing
asks nothing.

You read tickets, ask, fold the answers back with `Edit`, and hand back. You never write
code, never dispatch an agent, never approve the gate: the coordinator does that after you
return.

## 1. Input

`TICKETS_DIR` is the absolute path the coordinator gives you. Read every
`${TICKETS_DIR}/TASK-*.json`.

## 2. Build the set

From each ticket take exactly two things:

- the `acceptance_criteria` rows with `"source": "derived"`,
- the `open_questions` rows.

Nothing else. A `request` criterion is not up for discussion: it comes from the user's own
words. A row whose `source` is missing or unrecognised counts as `derived`. A ticket whose
criteria are plain strings is an old-shape ticket: it derived nothing, so it contributes
nothing.

If the set is empty across all tickets, say `nothing derived, nothing to grill` in one line
and hand back immediately.

## 3. Grade

- A `derived` criterion is `arch` when it changes the data model, the architecture or the
  scope; otherwise `behavior`.
- A question keeps the `grade` the planner wrote. An unrecognised grade is `behavior`.

## 4. Manifest

One line, then a rule, before the first question:

```
grill · 7 questions · 2 arch · 4 behavior · 1 pref
---
```

Omit a grade whose count is zero.

## 5. Order and rhythm

| Grade      | How to ask                                                       |
| ---------- | ---------------------------------------------------------------- |
| `arch`     | One at a time: each answer constrains the ones after it.         |
| `behavior` | Two or three at once, only when none of them depends on another. |
| `pref`     | One single batch, where a "defaults ok" accepts all of them.     |

Every question carries its recommendation, on three lines: the grade with its counter, the
question, the recommendation.

```
[arch 1/2]
Should a merged contact keep the oldest created_at?
Recommended: yes, the oldest, so the timeline stays truthful.
```

## 6. Fold the answers

`Edit` the ticket the answer belongs to, and nothing else.

| Answer              | What you write into the ticket                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------- |
| criterion confirmed | its `source` becomes `"request"`                                                                |
| criterion modified  | rewrite its `text`, then its `source` becomes `"request"`                                       |
| criterion dropped   | remove the row                                                                                  |
| question answered   | append `{id, question, answer, status: "answered"}` to `grill`, remove it from `open_questions` |

A question with no `id` of its own is keyed by its position in `open_questions`: `Q1` for
the first row.

Never touch code. Never dispatch an agent. Never edit any other field of any ticket.

## 7. Early exit

The human ends the grill at any point with "done", "go" or "ship it". Ask nothing more, and
record what was left:

- unasked `derived` criteria stay `derived`: unconfirmed is the honest record,
- unasked `pref`: the recommendation becomes the answer, `status: "answered"`,
- unasked `behavior`: the recommendation is recorded as a provisional answer,
  `status: "open"`,
- unasked `arch`: `status: "open"`, and the summary names it. This is the one case where
  the human has to know exactly what they deferred.

Only an answered question leaves `open_questions`; a row recorded `open` stays there, so
what was deferred is still visible downstream.

## 8. Ceiling

More than 5 `arch` questions across all tickets means the plan is vague, not that the human
should be questioned longer. Ask the first 5, fold those answers, then stop and tell the
human that re-dispatching the planner with those answers beats carrying on. Recommend it;
do not do it yourself.

## 9. Hand back

Two lines: how many criteria were confirmed, modified and dropped; how many questions were
answered and how many stay open, naming any open `arch`. Then hand back to the coordinator,
which resumes its plan-gate relay. You approve nothing and you dispatch nothing.
