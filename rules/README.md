# What this directory is, and is not

A plugin has no `rules` component. `claude plugin details` enumerates what the runtime
loads from a plugin — skills, agents, hooks, MCP servers, LSP servers — and nothing here is
in that list. Measured from the `instructions` attachment each transcript records: in the
worktree that consumes the harness as a plugin and keeps no rules of its own, all 20 agents
of a full run received exactly four instruction files (user `CLAUDE.md`, project
`CLAUDE.md`, `AGENTS.md`, `MEMORY.md`).

A **project's** `.claude/rules/*.md` IS delivered, to every one of its subagents: in a
project carrying twelve rule files, every subagent received all twelve, by name, on all 18
dispatches measured.

So these files reach an agent only by being copied into a consuming project's
`.claude/rules/`. Two consequences the harness is built around:

- **Harness mechanics live inline in the agent files**, not here. What a developer must know
  about its worktree, its output contract and the commands it may not run is in
  `agents/developer.md`, so it works with no project setup at all. A rule here that repeats
  it is a second copy to keep in sync, which is how `agent-output-format.md` came to exist
  and why it no longer does.
- **An agent prompt must never cite a `.claude/rules/...` path.** Where the file exists its
  text is already in the prompt; where it does not, the pointer leads nowhere.

## `paths:` means dormant, not lazy

A rule with a `paths:` glob was never delivered in any run measured — `typescript.md`,
`web-patterns.md` and `web-security.md` sat in a project for months at zero deliveries, and
`git-policy.md` was dormant behind `paths: ["**/*"]`, which is the worst possible scope for
a rule about git, since a git command touches no file. Write `paths: []` (or no frontmatter)
for anything an agent must actually know.

## What a project should copy

| File                     | Copy it when                                                                                    |
| ------------------------ | ----------------------------------------------------------------------------------------------- |
| `coding-style.md`        | always — immutability, KISS/DRY/YAGNI, scope discipline, file size                              |
| `testing.md`             | always — the coverage floor AND the pertinence bar a reviewer judges against                    |
| `english-only.md`        | the repo is written in English                                                                  |
| `git-policy.md`          | always — what each role may do locally, and that nobody touches the remote                      |
| `dependency-safety.md`   | always — cheap, and explains the `deny` an agent will otherwise fight                           |
| `security-triggers.md`   | always — a sizing rule: what must be COMPLEX because SIMPLE skips the review                    |
| `code-search.md`         | always — `LSP` is unavailable to harness agents; this says what to use instead                  |
| `worktree-scope.md`      | you want the full rationale and the violation examples; the agents already carry the essentials |
| `validation-commands.md` | same — the enforcement is in the hooks either way                                               |

`hook-authoring.md` and `launcher-interface.md` are documentation for whoever works on the
harness itself. They belong in no project's `.claude/rules/`.
