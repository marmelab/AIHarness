# Git: commits, push, PR

## Default position

- Never commit, push or open a PR without explicit user validation for THIS specific
  action (a validation at the start of a session isn't a blank check for what follows).
- Before proposing a commit: show the diff, not just a summary. Wait for confirmation.
- If the team/project chooses to delegate commit+push+PR to the agent (Adrien/Guillaume
  pattern), that choice must be written explicitly here, with the non-negotiable
  counterpart: systematic human review of the diff before any push, never a merged PR
  without human review.

## Commit and PR messages

- Concise, no sprawling description. A commit message = one summary line (imperative,
  English); a PR description = 3 to 6 lines maximum (Problem, Solution, How to test, Additional checks),
  not a novel.
- See the `pr-description` skill for a ready-to-use template.

## What the agent never does, even when validated

- Force-push on a shared branch.
- `git commit --no-verify` / bypassing existing git hooks.
- Rewrite the history of a branch already pushed and reviewed by someone else.
- Merge its own PR.
