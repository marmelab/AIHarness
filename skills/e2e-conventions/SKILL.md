---
name: e2e-conventions
description: When to write e2e tests, where to put them, and how to verify them. Apply to any task touching UI, filters, forms, or interactions.
---

# E2E Conventions

Reference for _whether_ an e2e test is required, _where_ it goes, and _what_ it must assert. For the assertion/locator patterns inside the spec, see
`Skill({skill: "playwright-testing"})`.

## When e2e tests are required

A change **requires** an e2e test if it touches any of:

- UI components or pages
- Filters or search
- Forms or user input
- Interactions (click, drag, keyboard)

Exception: pure CSS or a DB-migration-only change. State this explicitly in the task notes.

## Where to put them

Under `e2e/`, named after the feature:

```
e2e/<feature-name>.spec.ts
```

If the work is tracked under a ticket id, you may prefix the file with it (e.g. `e2e/TASK-001-deal-importance.spec.ts`) to make it easy to find — but the ticket id is not required.

## What to verify

Write the spec alongside the implementation. The reviewer checks that the spec exists and asserts the right thing. CI runs it — don't run it locally yourself.

## Every spec runs under EVERY configured project

Read the `projects` array in the repo's Playwright config before you assert on anything
whose presence depends on the viewport. The suite runs each spec once per project, so a
config with a desktop project and a mobile one runs your spec at both widths, and an
assertion on a control that only the wide layout renders fails at the narrow one.

This is the single most expensive mistake in an e2e spec, because it does not fail where
you wrote it: the per-ticket validation chain does not run the suite, so a viewport-blind
assertion passes review, passes the merge, and only fails at end-of-feature, where
repairing it costs a whole extra developer + review + merge round on a green feature.

Before asserting on a toolbar button, a sort or filter control, a sidebar, a column, or
anything else the responsive layout drops:

- Find the equivalent control in the narrow layout, and assert on whichever one is present,
  **or**
- Guard the assertion on the viewport (Playwright exposes the project name and the viewport
  size to the test), **or**
- Verify at the narrow viewport yourself before committing: `browser_resize` then
  `browser_snapshot` answers it in two calls.

Never widen the viewport in the spec to make a desktop-only assertion pass: that deletes
the mobile coverage the project asked for.

The project's own `e2e-conventions` skill, when it has one, states which projects are
actually configured and which controls differ between them. Prefer those concrete facts
over re-deriving them.

## Importing CJS packages in specs

Specs run under the test runner's Node ESM loader, not the app bundler. A CJS
package arrives wrapped there, so the namespace form yields a module object whose
members are undefined at call time:

```ts
import * as Papa from "papaparse"; // WRONG in e2e/: Papa.parse is undefined
import Papa from "papaparse"; // correct
```

`papaparse` is the known case: use the **default import** in `e2e/`. The same
package may legitimately keep the namespace form under `src/`, where the bundler
applies interop, so do not "fix" `src/` to match.

The compiler will not catch this when the package ships ESM-shaped types (both
forms typecheck), so enforce it with an ESLint `no-restricted-imports` entry
scoped to `e2e/`, using `importNames: ["*"]` to ban only the namespace form.

## Red Flags

- A UI/filter/form/interaction change with no `e2e/*.spec.ts` added.
- A namespace import of a CJS package (`import * as X`) inside `e2e/`.
- Claiming the CSS/migration-only exception without saying so in the task notes.
- A spec placed outside `e2e/`, or that asserts nothing user-visible.
- Running the e2e suite locally instead of letting CI do it.
- An unconditional assertion on a viewport-dependent control, when the config declares
  more than one project.
- A spec that resizes the viewport wider so a desktop-only assertion passes.

## Verification

- [ ] If the change touches UI/filters/forms/interactions, a spec exists under `e2e/`.
- [ ] The spec is named after the feature (ticket-id prefix optional).
- [ ] The spec asserts the right user-visible behavior, using `playwright-testing` patterns.
- [ ] Any CSS/migration-only exemption is stated explicitly in the task notes.
- [ ] CJS packages are default-imported in the spec, not namespace-imported.
- [ ] Every viewport-dependent assertion holds under each project in the Playwright config.
