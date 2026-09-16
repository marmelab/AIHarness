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

`TICKETS_DIR` is the absolute path the coordinator gives you. Read every `TASK-*.json`
there. If that finds none, try the next directory and stop at the first one that holds
ticket files:

1. `${TICKETS_DIR}`
2. its parent, the session dir itself
3. the session's runtime scratchpad parent, `/tmp/claude-<uid>/<project>/<session_id>/`

The orchestrator is told the session dir and does not always write there, so "no file under
`TICKETS_DIR`" is not "no tickets". Remember which directory answered: you name it when you
hand back.

## 2. Build the set

From each ticket take exactly two things:

- the `acceptance_criteria` rows with `"source": "derived"`,
- the `open_questions` rows.

Nothing else. A `request` criterion is not up for discussion: it comes from the user's own
words. A row whose `source` is missing or unrecognised counts as `derived`. A ticket whose
criteria are plain strings is an old-shape ticket: its CRITERIA contribute nothing. Its
`open_questions` still count, they are read the same way on every ticket.

Two empty cases exist and they must never read alike. Hand back immediately in either, in
its own wording:

- **No `TASK-*.json` under ANY of the three directories.** Hand back a WARNING: name the
  three paths you tried, then say that the grill did NOT run and that this plan was NOT
  grilled. You did not find a plan with nothing to ask about, you failed to find the plan.
  Never phrase it as an all-clear and never let it pass for one.
- **Tickets read, and nothing in them is `derived` or open.** Hand back one line: how many
  tickets you read, the directory they came from, and "nothing derived, nothing to grill".
  That one IS the all-clear.

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

Omit a grade whose count is zero. Under the rule, whatever the count, add one line:
answering "go" at any point ends the grill, finalising the remaining `pref` recommendations
and leaving `behavior` and `arch` open with their recommendation standing as provisional
(§7). The early exit is the human's, and a rule they are never told about is not one they
can use.

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

With no `PERSONA: technical` in the dispatch, keep that order but not that shape: ask in
plain language in the user's language, one question per message, with no grade tag, no
counter, no ticket id and no file path. The grades still decide what is asked when; they are
simply not shown.

Ask, then stop and wait for the answer. Never answer for the human, and never move past
what you asked before their answer has arrived.

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

`grill` is absent from most tickets: the planner never writes it. When the key is not
there, add it as a new top-level array holding that one entry; when it is, append to it.

After the last edit to a ticket, re-read the file and confirm it still parses as JSON. This
is the feature's only write path, and a malformed edit surfaces nowhere until the next
SubagentStop, after the approval, as a failed developer dispatch. If it does not parse,
restore what you changed and redo the edit.

Never touch code. Never dispatch an agent. Never edit any other field of any ticket.

## 7. Early exit

The human ends the grill at any point with "done", "go" or "ship it". Ask nothing more, and
record what was left:

- unasked `derived` criteria stay `derived`: unconfirmed is the honest record,
- unasked `pref`: the recommendation becomes the answer, folded as `status: "answered"`,
- unasked `behavior`: left open, its `recommended` standing as the provisional answer,
- unasked `arch`: left open, and the summary names it. This is the one case where the human
  has to know exactly what they deferred.

A question with an empty `recommended` is never taken as accepted, `pref` included: there
is nothing to accept, so it is left open.

Answered and open never overlap: an answered question is added to `grill` AND removed from
`open_questions`; an open one is left exactly where it is, untouched in `open_questions`,
with NO `grill` entry. `open_questions` means still open, `grill` means decided, and
nothing else on the ticket is edited.

## 8. Ceiling

More than 5 `arch` questions across all tickets means the plan is vague, not that the human
should be questioned longer. Ask the first 5, fold those answers, then stop and tell the
human that re-dispatching the planner with those answers beats carrying on. Recommend it;
do not do it yourself. The stop records everything still unasked exactly as an early exit
does.

## 9. Hand back

Two lines: the directory you read and how many criteria were confirmed, modified and
dropped; how many questions were answered and how many stay open, naming any open `arch`.
Then hand back to the coordinator, which resumes its plan-gate relay, asks for the approval
and dispatches what follows.
