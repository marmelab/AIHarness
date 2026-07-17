# Marmelab's AI harness kit

Gathers the elements that came up repeatedly as "what works" across differents projects.

## How to use it

Copy all elements except LICENSE and README.md in your project.

1. Fill `CLAUDE.md` and `AGENTS.md` with stack, commands, conventions.
2. Adapt `settings.json` commands (linter, tests) to the project's stack.

## Contents

| File | Description |
|---|---|
| `CLAUDE.md` | Only relevant informations for Claude Code |
| `AGENTS.md` | Context duplicated across AI tools (Claude/Copilot/Codex) |
| `.claude/settings.json` | Hooks application |
| `hooks/format-on-write.mjs` | Auto formatting |
| `hooks/bash-guard.mjs` | Prevent destructive commands | 
| `hooks/circuit-breaker.mjs` | Ensure no agent stuck in a loop / too many calls | 
| `hooks/check-typescript-shortcuts.mjs` | no `$TSFixMe`/`any` used to bypass typing |
| `hooks/pre-pr-checks.mjs` | Force check/tests before PRs pushed |
| `rules/coding-style.md` | No over-engineering, over-abstraction |
| `rules/testing.md` | No tests that bypass failure, coverage > relevance |
| `rules/git-policy.md` | Need to be adjusted to your needs |
| `rules/typescript.md` | No typing bypassed |
| `rules/dependency-safety.md` | Control package installation |
| `skills/grill-me/SKILL.md` | Force scope of plan |
| `skills/simplify/SKILL.md` | Avoid systematic over-engineering |
| `skills/pr-description/SKILL.md` | Way to write PR |
| `skills/end-of-feature-cleanup/SKILL.md` |  |
| `skills/review-hotspots/SKILL.md` | Review on main and hot findings |
| `skills/retro-capitalize/SKILL.md` | Documentation updates |
| `agents/code-reviewer.md` | How to make a review |
| `agents/test-writer.md` | How to write correct tests |
| `styles/concise-dev.md` | Avoid to much verbosity |
