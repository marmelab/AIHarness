---
name: simplify
description: Simplification pass to run at the end of implementation, before human review. Removes over-engineering (unnecessary abstractions, unjustified defensive error handling, unrequested code) without touching input validation, security or accessibility.
---

# simplify

Reread the diff of this session's changes (not the whole file only what
was added/modified) and apply the following ladder to every non-trivial
code block stop at the first rung that holds:

1. **Does this really need to exist?** (YAGNI remove if nothing actually uses it)
2. **Does the language's stdlib already do this?**
3. **Does a native platform/framework feature already do this?**
4. **Does a dependency already installed in the project already do this?**
5. **Would a single line suffice instead of the current block?**
6. **Otherwise, keep the minimum code that works.**

Concrete cases to prioritize:
- Interfaces, factories or abstraction layers created for a single call site.
- "Just in case" error handling on code that can't fail in this specific context.
- Code reimplementing a function already available in a project library.
- Added files or functions that weren't necessary for the original request.
- Comments that restate the code without adding information.

**Guardrails to never simplify away**: input validation, genuinely necessary
error handling (I/O, network, user input), security (auth, escaping,
permissions), accessibility. When in doubt about any of these, leave the code
as-is rather than risk a silent regression.

Finish with a short summary: what was removed/simplified, and, if
applicable, what you chose NOT to simplify and why.
