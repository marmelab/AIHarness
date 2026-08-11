# LSP — use semantic code intelligence when possible

Applies to: developer, quality-reviewer, planner.

This repo has an `LSP` tool backed by a TypeScript language server (declared by the plugin
manifest, covering `.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs` and `.cjs`). Use it
for any **semantic** question about TypeScript/JavaScript code. It resolves symbols
through the type system, so it is exact where text search only guesses.

## Read this before the rest: you may not have the tool at all

**`LSP` is DEFERRED, and on some surfaces it is not granted to subagents.** It is never in
a subagent's tool list at start, and listing it in the agent definition does not put it
there. Load it with `ToolSearch({query: "select:LSP"})` once, early.

**Two answers to that call, and both are normal.** A schema comes back and LSP is yours for
the turn. Or `No matching deferred tools found` comes back, and the tool does not exist in
this session: measured, subagents get LSP in a non-interactive run and do NOT get it in an
interactive one, where the runtime answers `LSP is disabled for this session, in subagents
as well`. Nothing in the plugin, the project settings or your prompt changes that.

**When it is absent, `grep` is the CORRECT answer, not a fallback you owe an excuse for.**
Ask once, take the answer, move on. Do not retry the load, do not hunt for a workaround, do
not report it as a blocker: three agent roles work this way every run on that surface. The
rest of this file describes what to do when the tool IS there.

**The first query can answer nothing.** `No symbols found in workspace ... has not finished
indexing` is the server warming up, not an empty repo. Repeat the same call once — measured,
a first call returned 0 symbols where the next two returned 5 and 6 for the same query.

Separately, only one LSP server owns a file extension: if another enabled plugin claims
`.ts` first, ours never starts and every call answers `Executable not found in $PATH`. The
session-start hook names that plugin when it happens; it is not something to work around
from an agent.

## The reflex to break: `grep`/`rg` in Bash to find a symbol

In practice the `Grep` tool is rarely used — code search here happens through
`grep`/`rg` **inside `Bash`** (`grep -rn "DealStage" src/`). That reflex is the
thing to stop for symbol questions. `grep` matches strings: it can't tell a
definition from a comment, a type from a same-named variable, or one `handleSubmit`
from another, and it silently misses re-exports and aliased imports. The `LSP` tool
resolves the actual symbol.

**Rule, when the tool loaded:** to find where a TypeScript identifier (a PascalCase
type/component, a camelCase function/hook, an exported const) is **defined** or **used** in
`.ts/.tsx/.js/.jsx`, call `LSP` rather than `grep -rn "<Symbol>" src/` in Bash. Reach for
LSP first whenever the question is "where / what / who", not "which files contain this
string". **When the tool did not load, that same question is a `grep` question** and the
table below is a description of what you are missing, not a rule you are breaking.

| Instead of this bash-grep…                                        | …use this LSP call                     |
| ----------------------------------------------------------------- | -------------------------------------- |
| `grep -rn "DealStage" src/` (every use of a type)                 | `findReferences` (impact/blast radius) |
| `grep -rn "mergeContacts" src/` (where defined)                   | `goToDefinition`                       |
| `grep -rn "LatestNotes\|useContactImport" src/` (locate a symbol) | `workspaceSymbol`                      |
| `grep -n "export" file.tsx` (what a file exports)                 | `documentSymbol`                       |
| `grep -rn "buildActivityLog" src/` (who calls it)                 | `incomingCalls`                        |

| Operation                         | Use it to                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| `goToDefinition`                  | jump to where a symbol is declared (type, function, component, prop)                              |
| `findReferences`                  | find every real use of a symbol before changing or renaming it — impact analysis                  |
| `hover`                           | get a symbol's resolved type / signature / JSDoc without opening its file                         |
| `documentSymbol`                  | outline a file's exports/functions/components before reading it whole                             |
| `workspaceSymbol`                 | locate a symbol by name across the repo (`query` required) — faster than grepping for a file path |
| `goToImplementation`              | find concrete implementations of an interface or abstract member                                  |
| `prepareCallHierarchy`            | get the call-hierarchy anchor at a position (precedes incoming/outgoing calls)                    |
| `incomingCalls` / `outgoingCalls` | trace the call graph into / out of a function                                                     |

Positions are **1-based** (`line`, `character`), exactly as shown in `Read` output
and editors.

## Per-agent fit

- **developer** — before editing a symbol's signature,
  `findReferences` to size the blast radius; `hover` to confirm a type;
  `goToDefinition` to reach the source. Prefer these over `grep -rn "<Symbol>" src/`
  in Bash whenever the tool loaded.
- **quality-reviewer** — `findReferences` / `incomingCalls` to check that every
  call site of a changed function is handled; `goToDefinition` to confirm a type
  is what the diff assumes; `findReferences` / `workspaceSymbol` to confirm a new
  component or resource is actually wired into the app (imported, registered),
  not merely created.
- **planner** — `workspaceSymbol` to locate probable `files_to_modify` faster than
  grep. Still light discovery — no deep reading.

## When `grep`/`rg` IS the right tool

LSP is for TS/JS symbols. Keep using `grep`/`rg` (in Bash) — and do not try LSP — for:

- **Non-TS/JS files**: `.sql`, `.md`, `.json`, `.css` — no server covers them.
- **Text / domain-word sweeps** that deliberately include strings, comments, and
  non-code: e.g. deleting a resource with `grep -rniE "\bdeals?\b|deal_notes?"`,
  which must catch SQL, fixtures, and labels — not just the TS symbol.
- **Database identifiers** (column / view names like `company_id`,
  `contacts_summary`) that live in SQL and string literals, not as TS symbols.
- Plain "which files mention 'boulangerie'" lookups.

LSP is **read-only code intelligence, not a validation command** — it does not run
`tsc`, so it is exempt from `validation-commands.md` and you may use it freely. It
does not replace the hook-run typecheck.

## Worktree note

Pass **absolute paths inside your own worktree** (`<WORKTREE_PATH>/src/...`), per
`worktree-scope.md` — never the base-branch checkout under `$CLAUDE_PROJECT_DIR`.
When LSP is unavailable, or returns an error or an empty result for a worktree file after
the one indexing retry, use `grep` / `Read` and carry on. Never block on it.
