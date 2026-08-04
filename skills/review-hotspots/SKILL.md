---
name: review-hotspots
description: Analyzes a PR (yours or a colleague's) and identifies 1 to 5 priority hotspots to review, rather than producing an exhaustive review report. Use alongside a human review, not in place of one.
---

# review-hotspots

Analyze the PR diff and produce a list of 1 to 5 hotspots MAXIMUM, no more,
even if you identify more possible remarks. A hotspot is a place where a
mistake would be costly or hard to catch on a quick read, not just any
possible improvement.

Prioritize in this order:
1. Non-trivial business logic or a change to existing behavior.
2. Areas touching security, permissions, sensitive data.
3. Code where the author flagged a hesitation (see `rules/coding-style.md`).
4. Cross-cutting ("plumbing") changes that touch several modules.
5. Modified or deleted tests (check that no test was weakened to make it pass, see `rules/testing.md`).

For each hotspot: the file/line, one sentence on the precise risk (not
"careful with this", but "this case can cause X if Y"), nothing more.

Don't list: style issues covered by the linter, subjective preferences
with no real risk, improvement suggestions that aren't risks. If the diff is
mechanical and has no identifiable risk, say so explicitly ("no hotspots
identified") rather than inventing remarks to fill the list.
