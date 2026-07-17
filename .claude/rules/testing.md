# Tests

## Non-negotiable principle

- If a test fails, fix the cause. NEVER modify the assertion, don't artificially mock
  the tested data, don't delete the test and don't mark it `.skip` to make it pass.
  If you think a test is genuinely obsolete or poorly written, say so explicitly to
  the user and wait for validation before changing it.
- Don't manually rerun typecheck/tests if a `validate-on-stop` hook (or equivalent CI)
  already does it automatically avoids duplicate work and false signals.

## Relevance before coverage

- Prioritize business-logic tests (observable behavior, real edge cases) over raw
  code coverage.
- Don't generate a test that checks the obvious (e.g. "an element removed from the
  DOM has indeed disappeared"). Ask yourself what could actually break.
- Full `toEqual` rather than partial `toHaveProperty` a partial test hides
  regressions on unchecked fields.
- No assertions on CSS classes or implementation details that don't represent
  user-facing behavior.
- No heavy mocks that pin down internal implementation rather than behavior.
- Deterministic tests: no dependency on the system clock, real network, or implicit
  execution order. No arbitrary `waitForTimeout` in e2e tests wait for a state, not
  a duration.
- Jest/Vitest always in the foreground (no backgrounded process) to keep direct feedback.

## Who writes the tests

- If the project has a dedicated `test-writer` agent/skill, the development agent
  doesn't write tests itself for structural changes: it delegates and flags missing
  or obsolete tests detected during review (see `.claude/agents/test-writer.md`).
