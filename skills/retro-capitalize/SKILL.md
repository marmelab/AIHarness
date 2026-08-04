---
name: retro-capitalize
description: End-of-session ritual, asks what was learned during the session and files each learning in the right place (CLAUDE.md, rules, skills, docs, ADR). Run systematically at the end of any non-trivial work session.
---

# retro-capitalize

At the end of a session, before closing:

1. Answer the question: what from this session would be worth knowing next
   time (a pitfall hit, a clarified convention, an architecture decision, a
   non-intuitive business behavior)?
2. For each item identified, file it in the right place, don't put anything
   "by default" into CLAUDE.md:

   | Type of learning | Destination |
   |---|---|
   | General code convention, transposable to other projects | `.claude/rules/` |
   | Reusable technical capability (workflow, command sequence) | `.claude/skills/<name>/SKILL.md` |
   | Business detail or pitfall specific to THIS project, not inferable from the code | `CLAUDE.md` ("Known pitfalls" section) |
   | Longer project technical detail (schema, full flow) | dedicated Markdown doc (`docs/`) |
   | Structural architecture decision with weighed alternatives | ADR (`docs/adr/`) |
   | Bug fixed after a missed check/guardrail | bug writeup (cause, fix), see the "don't fix it yourself, have it investigated and documented first" principle |

3. Interlink: if a CLAUDE.md/rule file references a concept detailed
   elsewhere, add a link rather than duplicating the content.
4. If nothing is worth capitalizing on, say so explicitly rather than forcing
   an artificial addition. A CLAUDE.md that grows without discipline is
   worse than an incomplete one.
