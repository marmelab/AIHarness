# <Project name>: agent context

## What the project does

<2-3 sentences, business context>

## Stack & commands

- Stack: <e.g. TypeScript strict, React, react-admin, Vite, Vitest>
- Install: `<command>`
- Run in dev: `<command>`
- Run tests: `<command>` (don't rerun manually if a `validate-on-stop` hook already does, see `rules/testing.md`)
- Lint / typecheck: `<command>`
- Build: `<command>`

## Architecture

- <2-4 lines max on the general architecture>
- Detailed architecture decisions: see `docs/adr/` (a glossary here if needed, not the content)

## Business domain (what an agent can't guess from the code)

- <e.g. "a soft-deleted contact remains visible in historical reports">
- <e.g. "the `pending` status must never be triggered client-side">

## Code conventions

- <e.g. functional components only, no classes>
- <e.g. Zod for all input validation>
- <e.g. files of 200 to 400 lines, 800 lines = signal to split>

## Non-negotiable rules

- Code, comments and commits in English. Avoid the "—" character.
- Never introduce `any` or a workaround equivalent (`$TSFixMe`, `@ts-ignore` without a comment), see `rules/typescript.md`.
- On a non-trivial task: propose a plan, ask clarifying questions in prose (never a multiple-choice menu), wait for validation, then implement in small steps.
- One step, one review. Don't chain several unreviewed steps.
- Never commit, push or open a PR without explicit validation, see `rules/git-policy.md`.
- End of feature: `/ponytail-review` for over-engineering, then a human review.
- Never expand the scope of a request without explicitly flagging it (no unrequested renaming, refactor or "improvement").
- Flag the part of the work where you hesitated and why, at the end of the plan or implementation. This focuses the review on uncertainty rather than on everything.

## Known pitfalls on this project

<!-- Fed via the end-of-session ritual: "What did you learn during this session?"
     A generic pitfall goes into rules/, a business-specific pitfall goes here. -->

- <e.g. "MUI + responsive: mobile behavior doesn't rely on the default breakpoint, see ADR-012">

## Contacts / project owners

<who validates architecture decisions, who to ask in case of business doubt>
