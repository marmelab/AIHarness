---
name: grill-me
description: Asks a series of probing questions about a feature request before any implementation, to force thinking about unanticipated angles. Use when the request is vague, when the scope seems broad, or when classic plan mode produces a plan that's too generic.
---

# grill-me

Before writing a plan or code, ask the user a series of questions that probe
the request from several angles, one at a time if needed, in prose (never a
multiple-choice menu). Goal: surface what the user hasn't anticipated, not
just confirm what they've already said.

Cover at minimum:

1. **Scope**: what's explicitly out of scope? What might seem included but isn't?
2. **Edge cases**: what should happen on empty/invalid input, network error,
   concurrency (two users at the same time)?
3. **Existing interactions**: does this feature touch behavior already in
   place elsewhere (permissions, cache, shared state)?
4. **Definition of "done"**: what does a manual test that confirms it's done
   look like? Who needs to validate before merge?
5. **Reversibility**: if it's a bad idea, how easy is it to undo?

Don't implement anything until the answers cover at least scope and edge
cases. If the user answers "I don't know" to a structural question, propose
an explicit hypothesis and ask for confirmation rather than silently choosing.
