# The core / adapter / project split

How this repo decides what belongs to the harness and what belongs to a project using it.
Written when the harness was extracted from `marmelab/atomic-crm`, where it had grown to
156 files under `.claude/`.

## The measurement it rests on

Coupling was counted mechanically, not judged: occurrences of `supabase|RLS|PostgREST`,
`shadcn|fakerest|react-admin|ra-core|vite`, and the project name. **112 of the 156 files,
10 282 lines, contained zero project vocabulary.**

| area | files | clean | coupled |
|---|---|---|---|
| `hooks/lib/` | 16 | 15 | 1 |
| `hooks/` | 31 | 24 | 7 |
| `hooks/test/` | 40 | 35 | 5 |
| `commands/` | 8 | 8 | 0 |
| `rules/` | 15 | 10 | 5 |
| `agents/` | 7 | 3 | 4 |
| `scripts/` | 8 | 5 | 3 |
| `skills/` | 23 | 9 | 14 |

Across the 47 files of `hooks/` and `hooks/lib/`, real code coupling came to **four
lines**: a deprecated author-identity regex branch and a lock filename. Everything else
was comments and message strings. The engine was already portable; what was not was the
agent prompts and the domain skills.

## Layer 1: the core (this repo)

The enforcement layer, the agent team, and the skills that describe how to work rather
than what this product is:

- `hooks/` and `hooks/lib/` — worktree provisioning, dispatch gates, validation on stop,
  review-verdict bookkeeping, session bootstrap and teardown.
- `hooks/test/` and `scripts/test/` — **not optional.** These are the core's only
  regression net, and the reason is empirical: `completion-invariant` had been silently
  inert for months because it looked for verdict flags in a directory that never existed,
  and nothing reported it. Shipping the core without its tests reproduces that class of
  failure in every consuming project at once.
- `agents/` — the seven roles. Four still carry stack-specific sections, see below.
- `rules/` — the mechanics (worktree scope, output contracts, validation commands,
  security triggers) and the team conventions (coding style, testing, English-only).
- `skills/` — ponytail, ADR writing, e2e conventions, Playwright patterns, grill-me,
  worktree detection, rollback-conflict resolution, setup interview, PR description.
- `commands/` — `/harness-diff`, `/harness-revert`, `/harness-target`, the ponytail set.
- `scripts/` — config-sync check, revert, statusline, monitor, Playwright MCP launcher.

## Layer 2: adapters

An adapter owns everything one backend or one surface implies, and is dormant unless the
consuming project's `harness.config.json` activates it.

- **`adapters/supabase`** (`provides: deploy`) — the deploy-time migration round and the
  isolated slot-leased e2e stack: `scripts/{e2e-smoke.sh,apply-migrations.mjs,pending-deploys.mjs}`,
  `skills/writing-migrations`, `hooks/block-migration-writes.mjs`.
- **`adapters/launcher-chat-service`** (`provides: launcher`) — the four
  `config.launcher` extension points plus the ask-state cartouche. Configuration and
  documentation only: no code, and every consumer is inert when the block is absent.

## Layer 3: the project

What stays in the consuming repo:

- `harness.config.json` — the contract: validation steps, roles, allowed containers,
  deploy adapter, app smoke, launcher extension points, developer skill menu.
- `.claude/settings.json` — permissions, env, and any project-only hooks. The plugin
  supplies its own `hooks/hooks.json`, so this no longer carries the harness's hooks.
- Domain skills. In atomic-crm those were `delete-initial-resource` (271 coupling hits
  over 6 files, the most coupled thing in that repo), `backend-dev`,
  `shadcn-customization`, `frontend-dev`, `update-branding`.

## Two seams that make the same core work in both layouts

The harness can be an installed plugin or a copy inside a project's `.claude/`. Two
places had to stop assuming:

- `hooks/lib/paths.mjs` `harnessFile()` resolves a harness-owned file through
  `CLAUDE_PLUGIN_ROOT` first, then the project's `.claude/`. Used by
  `e2e-on-feature-review.mjs` and `lib/session-state.mjs`, which used to hardcode
  `<repo>/.claude/scripts/...`.
- `scripts/check-config-sync.mjs` reads SubagentStop matchers from **both** the plugin's
  `hooks/hooks.json` and the project's `.claude/settings.json`, so a project that forgets
  to declare a role the plugin's matchers name is caught rather than running with a
  dangling matcher.

## What the extraction changed, beyond moving files

- `block-docker-containers` used to hardcode one vendor as "the single allowed stack".
  The allowed set is now `harness.config.json` `containers.allow`, empty by default,
  which blocks every launch: a project opts its own stack in.
- Four test files were implicitly reading the host repo's `harness.config.json`, so their
  outcome depended on which project happened to contain the core. They now pin their own
  fixtures. `turn-complete`'s test also stopped writing into the shared real
  `/tmp/pty-sentinels`.
- The documentator wrote its Mode 1 artifacts under a hardcoded `/home/developer/...`,
  a path that does not exist in every container. It uses `$CLAUDE_CONFIG_DIR` now.
- The deprecated `CRM_TMP_ROOT` and `documentator@atomic-crm.local` fallbacks, both
  marked "kept for one release", are gone.

## What was dropped from the previous kit

The repo used to carry six files aimed at a developer working WITHOUT the harness. Five
were redundant once the harness arrived, and they are out (still in `main`'s history):

| dropped | already owned by |
|---|---|
| `end-of-feature-cleanup` | its four steps each have an owner: `ponytail-review` (loaded by the quality-reviewer), the documentator, `adr-writing` (loaded by the developer), and the ticket's acceptance criteria |
| `retro-capitalize` | the documentator's Mode 1 and Mode 2, same destination table, orchestrator-triggered |
| `simplify` | ponytail, including the guardrails ("never simplify away input validation, security, accessibility") verbatim in intent |
| `review-hotspots` | the quality-reviewer's required "Hotspots for human review" section, same 1-to-5 cap and same priority order |
| `code-reviewer` | 27 lines competing with Anthropic's maintained `code-review` plugin and `security-review` |

`pr-description` stayed, because it is the one that filled a verifiable gap: the team's
Problem / Solution / How to test convention otherwise lives only in a personal
`~/.claude/commands/pr`, so it was not shareable.

Two consequences were fixed rather than left dangling: `pr-description` had its hotspot
method inlined instead of pointing at the removed skill, and `templates/AGENTS.md` now
points at `/ponytail-review` instead of a `/simplify` the plugin no longer ships.

## What is deliberately not done yet

**The four coupled agent prompts.** `agents/quality-reviewer.md` (47 coupling hits, whole
sections: `A.6b Supabase schema changes`, `B.1 Supabase RLS`), `agents/planner.md` (24),
`agents/developer.md` (12) and `agents/orchestrator.md` (11) still inline stack facts
instead of reading them. This is the one place the harness's own rule, *project facts live
in `harness.config.json`*, is not followed.

Until the adapter owns those fragments, a non-Supabase project has to edit three large
prompts by hand. Extracting them is the next step, and it deserves its own review: it
touches roughly 1 700 lines of prompt, and a prompt regression is not caught by a test
suite the way a hook regression is.
