---
name: end-of-feature-cleanup
description: Sequence to run at the very end of a feature, once the code works simplification, reasonable refactoring, documentation. Don't invoke mid-development, only at closeout.
---

# end-of-feature-cleanup

Run in order, without skipping a step:

1. **Simplification** invoke the `simplify` skill on the whole feature diff (not just the last change).
2. **Reasonable refactoring** identify real duplication introduced BY this feature (not pre-existing duplication elsewhere in the codebase, out of scope). Only refactor if the pattern appears at least 3 times. Don't factor across modules that have no business reason to evolve together.
3. **Documentation** for every non-obvious decision made during implementation, add a note in the right place:
   - General, reusable code convention → `.claude/rules/`
   - Business/project detail not inferable from the code → `CLAUDE.md`
   - Structural architecture decision → an ADR (`docs/adr/`)
   - Don't document what's already readable in the code itself.
4. **Test plan** verify a test plan for the feature exists (happy path + identified edge cases), not just the unit tests written along the way.

Finish with a short summary of what was simplified, refactored and documented,
so the human review knows where to look.
