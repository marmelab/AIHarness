---
name: pr-description
description: Writes a short, concise PR description following a fixed template, to avoid the "sprawling" descriptions the team systematically rewrites by hand. Invoke before opening a PR.
---

# pr-description

Generate the PR description following EXACTLY this template, without adding
any extra section, without "Summary by CodeRabbit"-style content, without emoji:

```markdown
## Problem

<1-2 sentences: what problem, what ticket>

## Solution

<3-5 lines maximum, factual, not a paraphrase of the diff>

## How to test

<concrete steps, or "see tests added in X">

## Hotspots

<0-3 lines: the parts of the diff that most deserve the reviewer's attention,
or "none mechanical change". A hotspot is a place where a mistake would be
costly or hard to catch on a quick read, not just any possible improvement:
non-trivial business logic, a change to existing behavior, security or
permissions, or a modified/deleted test.>
```

Strict rules:

- Each section stays within the stated line limit. If you go over, cut rather than keep everything.
- No duplicate "Testing" AND "How to test" sections, no list of modified files (already visible in the diff).
- Don't invent business context absent from the ticket or conversation. If the context isn't known, write "see ticket <ref>" rather than a generic paraphrase.
- The associated commit message follows `rules/git-policy.md` (one line, imperative, English).
