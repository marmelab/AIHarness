# TypeScript

- Never bypass typing: no `any`, no `$TSFixMe`, no `@ts-ignore`/`@ts-expect-error`
  without a comment precisely explaining why the workaround is necessary and temporary.
- If getting the correct type is difficult, say so explicitly rather than silently
  working around it this is often a sign of a deeper design problem.
- Zod (or equivalent) for all data validation coming from outside (API, form, file):
  don't trust a TypeScript type alone for data uncontrolled at compile time.
- A hook (`check-typescript-shortcuts.mjs`) automatically flags these workarounds on
  modified `.ts`/`.tsx` files don't try to bypass it either.
