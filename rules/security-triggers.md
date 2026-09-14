---
paths: []
---

# Security Review Triggers

There is no separate security reviewer. The security pass is Part B of the
`quality-reviewer` rubric, and it runs whenever that agent reviews a diff:

- COMPLEX flow: every ticket is reviewed before merge, so every ticket gets the pass.
- SIMPLE flow: the review runs only when the diff touches a deploy-relevant path
  (`config.deploy.relevantGlobs`, empty when the project declares no deploy adapter, so
  such a project reviews no SIMPLE change at all). Anything else merges unreviewed.
- `/harness-review`: one reviewer against a diff, on demand, no pipeline.

So the list below is a sizing rule, not a dispatch rule. A change touching any of these
areas is COMPLEX (`LEVEL: feature`) even when it fits in one file, because SIMPLE is the
flow that skips the reviewer:

- Authentication or authorization code
- User input handling (forms, URL params, request body)
- Database queries or migrations
- File system operations
- External API calls
- Cryptographic operations
- Payment or financial code
- Row-level security policies

`LEVEL: bugfix` or `LEVEL: small` on such code ships it without the pass. That is the
asker's decision, and the harness does not second-guess it. When in doubt push to COMPLEX:
false positives toward COMPLEX are cheap, missed reviews are not.
