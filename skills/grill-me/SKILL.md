---
name: grill-me
description: Scope a #harness request before dispatching the orchestrator. Invoke on EVERY #harness request, in the main thread. Step 0 decides whether questions are needed and exits in one line when the scope is already precise, so the decision is always made and always visible.
---

# grill-me

Surface what the user has NOT anticipated, before any plan or code exists.

## Step 0: decide, out loud

Do not judge whether to invoke this skill; you already did. Judge here, once, and say the
answer.

Apply the same test that ends the grilling, at its start: **could you write the
orchestrator dispatch prompt right now without guessing** at scope-out, acceptance, or
which existing behavior this touches?

- **Yes** -> say so in one line, naming what makes it precise ("scope already precise:
  one field, acceptance stated, no existing behavior touched"), then dispatch. Done.
- **No** -> grill, starting with whichever area below is emptiest.

**Never skip silently.** The one-line exit is what tells the user why no questions came.
Without it, "already precise" and "the skill never ran" look identical from the outside,
and only one of them is fine.

## How to grill

- **One question at a time**, in prose. Never a multiple-choice menu, never a batch of
  five at once.
- Read the answer, then ask the next most valuable question given it.
- **Stop as soon as the scope is answerable** by the Step 0 test. Do not interrogate for
  its own sake.

## Cover, at minimum

1. **Scope-out**: what is explicitly NOT in scope? What might look included but isn't?
2. **Edge cases**: empty / invalid input, network or backend error, two users at once.
3. **Existing interactions**: does this touch behavior already in place (permissions,
   RLS, cached data, shared views, another resource)?
4. **Definition of done**: what manual check confirms it works? Who validates before merge?
5. **Reversibility**: if it turns out wrong, how hard is it to undo?

If the user answers "I don't know" to a structural question, propose an explicit
hypothesis and ask them to confirm rather than silently choosing.

## After grilling

Fold the answers into the orchestrator dispatch prompt: scope-out and acceptance become
ticket constraints.
