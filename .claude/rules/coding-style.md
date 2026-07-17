# Code style

## Simplicity above all

- Simple > clever. The first version that works, not the most elegant one possible.
- Don't add an abstraction (interface, factory, generic config) for a single call site.
  Rule of thumb: at least 3 real usages before abstracting.
- Never reimplement functionality already covered by a project library or the stdlib
  suggest using it instead of recoding it.
- Don't add code, files or tests that weren't requested. If you think an addition is
  useful, propose it explicitly to the user instead of implementing it directly.
- No defensive "just in case" error handling on code that can't fail in this context.
- "Leave early": guard clauses at the top of a function rather than nested ifs.
- A single return type and a single error channel per function (no mixing exception/null value/error code).
- Easy to delete rather than easy to extend: prefer code that can be thrown away and
  rewritten over an architecture that anticipates hypothetical needs.

## Comments

- No comment that restates what the code already says. A comment should explain a
  non-obvious "why", not a "what".
- Remove comments you add out of reflex if, on rereading, they add nothing.

## End of task

- At the end of a feature or non-trivial task: go through a deliberate simplification
  pass (see the `simplify` skill) before proposing the code for human review.
- Describe your approach before writing code on any non-trivial task (not just in
  plan mode): this catches a bad direction before it costs time.
- Explicitly flag where you hesitated and why (feedback rated as very impactful:
  "tell me where you hesitated and why" focuses the review on uncertainty rather than on everything).
