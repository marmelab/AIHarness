---
paths: []
---

# Searching code

Applies to: developer, quality-reviewer, planner, test-writer.

## The `LSP` tool is not available to you

Every harness agent is dispatched by the orchestrator, which is itself a subagent, so they
all run in the background — and a background subagent has `LSP` pruned from its tool set,
whatever its `tools:` frontmatter says. Four open runtime bugs, no fix
(anthropics/claude-code#76090, #80733, #84125, #85310). Measured over a full run: 20 agents,
0 LSP calls.

**So do not spend a turn checking.** `ToolSearch select:LSP` costs a turn and returns
nothing. The tools below answer the same questions.

## Which tool for which question

| Question                                        | Tool                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Where is this file / what is in it              | `Read` — never `sed -n`, `cat`, `head` through Bash (refused by `bash-guard`, and a Bash call pays a per-call toll orders of magnitude larger) |
| Which files contain this string                 | the `Grep` tool — never `grep -rn` through Bash                                                                                                |
| Which files exist under this pattern            | `Glob`                                                                                                                                         |
| Who really calls this function, every call site | `node "${CLAUDE_PLUGIN_ROOT}/scripts/ts-symbols.mjs" refs <file> <line> <col>`                                                                 |
| Where is this symbol declared                   | `ts-symbols.mjs def <file> <line> <col>`                                                                                                       |
| Which file holds the symbol named X             | `ts-symbols.mjs sym <name>`                                                                                                                    |
| Did I break every caller of what I changed      | the typecheck, which the SubagentStop chain runs on your stop                                                                                  |

`ts-symbols.mjs` resolves through the project's own TypeScript program, so it answers for
the real symbol: text search cannot tell a definition from a comment, misses re-exports and
aliased imports, and answers for every same-named symbol at once. A call costs about what
the grep it replaces costs, so reach for it for correctness, not for speed — "who calls
this, and did I miss one" is worth it, "which files mention this word" is not.

**The typecheck is the real blast-radius net**, and it is already paid for: it runs on every
developer stop and refuses the stop when a call site is broken. An exhaustive `refs` sweep
before a signature change is useful for planning the edit, not for proving you finished it.

## When Bash is the right tool

Pipelines, git, and text sweeps that deliberately include strings, comments and non-code:
deleting every mention of a resource (`grep -rniE "\bdeals?\b|deal_notes?"` across SQL,
fixtures and labels), database identifiers that live in SQL and string literals
(`contacts_summary`, `company_id`), and any file `Grep` covers no better.
