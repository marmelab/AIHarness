---
name: e2e-conventions
description: When to write e2e tests, where to put them, and how to verify them. Apply to any task touching UI, filters, forms, or interactions.
---

# E2E Conventions

Reference for *whether* an e2e test is required, *where* it goes, and *what* it must assert. For the assertion/locator patterns inside the spec, see
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

## Verification

- [ ] If the change touches UI/filters/forms/interactions, a spec exists under `e2e/`.
- [ ] The spec is named after the feature (ticket-id prefix optional).
- [ ] The spec asserts the right user-visible behavior, using `playwright-testing` patterns.
- [ ] Any CSS/migration-only exemption is stated explicitly in the task notes.
- [ ] CJS packages are default-imported in the spec, not namespace-imported.
