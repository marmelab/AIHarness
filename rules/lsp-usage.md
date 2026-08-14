# Symbol questions: `ts-symbols.mjs`, not `grep`, not `LSP`

Applies to: developer, quality-reviewer, planner.

## `LSP` is not available to you. Do not spend a turn on it.

Every harness agent is dispatched by the orchestrator, which is itself a subagent and is
not given `run_in_background` to set, so every agent runs in the background, and a
background subagent has the `LSP` tool pruned from its set. Four open runtime reports, no
fix (anthropics/claude-code#76090, #80733, #84125, #85310), and the one confirmed
workaround is a foreground dispatch, which is exactly what a nested subagent cannot ask
for.

Measured on one full run: **21 agents, 0 LSP calls, 357 Bash calls.** Treat the tool as
absent. Do not call `ToolSearch({query: "select:LSP"})` to find out, do not retry it, do
not report its absence as a blocker.

(`LSP` stays in the agent tool lists because the same files are also read by interactive
sessions, where it does work. If you are reading this outside the pipeline and the tool IS
in your list, use it. The operations are `goToDefinition`, `findReferences`, `hover`,
`documentSymbol`, `workspaceSymbol`, `goToImplementation`, `incomingCalls` /
`outgoingCalls`, all 1-based positions.)

## Use `ts-symbols.mjs` for semantic questions

Bash reaches every agent on every surface. The plugin's script answers the same questions
through the project's own TypeScript program, with no new dependency:

```bash
cd <WORKTREE_PATH> && node "${CLAUDE_PLUGIN_ROOT}/scripts/ts-symbols.mjs" sym  <name>
cd <WORKTREE_PATH> && node "${CLAUDE_PLUGIN_ROOT}/scripts/ts-symbols.mjs" def  <file> <line> <col>
cd <WORKTREE_PATH> && node "${CLAUDE_PLUGIN_ROOT}/scripts/ts-symbols.mjs" refs <file> <line> <col>
```

Positions are 1-based, exactly as `Read` prints them. Paths are **absolute, inside your own
worktree** (`worktree-scope.md`), never the base-branch checkout under
`$CLAUDE_PROJECT_DIR`. It costs nothing against the Bash budget, and it is read-only
intelligence rather than a validation command, so `validation-commands.md` does not apply.

**Reach for it where being wrong is expensive, not as a blanket `grep` replacement.** A
call costs about what the `grep` it replaces costs, so the reason is correctness, never
speed:

| Question | Command |
| --- | --- |
| who uses this symbol, and did I miss a call site (before changing a signature) | `refs` |
| where is this actually declared | `def` |
| where does a symbol named X live | `sym` |

Text search cannot tell a definition from a comment, misses re-exports and aliased
imports, and answers for every same-named symbol at once. That is what `refs` buys.

## `grep` / `rg` is the right tool for the rest

Not a fallback you owe an excuse for, but the correct instrument for:

- **Non-TS/JS files**: `.sql`, `.md`, `.json`, `.css`.
- **Text / domain-word sweeps** that deliberately include strings, comments and non-code:
  deleting a resource with `grep -rniE "\bdeals?\b|deal_notes?"` must catch SQL, fixtures
  and labels, not just the TS symbol.
- **Database identifiers** (`company_id`, `contacts_summary`) that live in SQL and string
  literals, not as TS symbols.
- Plain "which files mention this string".

If `ts-symbols.mjs` errors or returns nothing for a worktree file, use `grep` / `Read` and
carry on. Never block on either tool.
