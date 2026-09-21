---
paths: []
---

# Security Review Triggers

There is no separate security reviewer. The security pass is Part B of the
`quality-reviewer` rubric, and it runs whenever that agent reviews a diff:

- COMPLEX flow: every ticket is reviewed before merge, so every ticket gets the pass.
- SIMPLE flow: every change is reviewed, once, single-shot, at the tier the harness
  computes from the diff. The tier sets the depth; it never drops the security pass.
- `/harness-review`: one reviewer against a diff, on demand, no pipeline.

So the list below is a sizing rule, not a dispatch rule. A change touching any of these
areas is COMPLEX (`LEVEL: feature`) even when it fits in one file, because of what the
COMPLEX flow buys that the single-shot pass cannot: a plan that states the blast radius
before any code exists, a review holding the ticket's acceptance criteria, and the
whole-feature pass at the end. Security-sensitive code is worth all three:

- Authentication or authorization code
- User input handling (forms, URL params, request body)
- Database queries or migrations
- File system operations
- External API calls
- Cryptographic operations
- Payment or financial code
- Row-level security policies

`LEVEL: bugfix` or `LEVEL: small` on such code ships it on one single-shot review, with no
plan and no second pass. That is the asker's decision, and the harness does not second-guess
it. When in doubt push to COMPLEX: false positives toward COMPLEX are cheap, a thin pass
over security-sensitive code is not.
