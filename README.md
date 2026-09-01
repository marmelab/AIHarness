# Marmelab's AI harness

A Claude Code plugin that turns a code-change request into a reviewed, merged change,
driven by a team of subagents working in git worktrees.

The point is not the agents, it is the **enforcement**. Every gate is a hook, so it fires
whether or not the model cooperates. A prompt that says "never merge yourself" is a
suggestion; a `PreToolUse` hook that refuses `git merge` is not. As this repo's own
dependency rule puts it: a deny is ~100% respected, a CLAUDE.md line is not.

## How it works

The orchestrator classifies the request, the planner breaks it into tickets, a developer
implements each one in its own worktree, the quality-reviewer reviews it, the merger merges
it into a session branch, and the whole feature is reviewed once more before promotion.
Around that, hooks:

- create and tear down the worktrees, so no agent invents its own layout
- run the validation chain (format, typecheck, lint, unit) on every developer stop, and
  reject the stop until it is green
- refuse to dispatch a merger without a recorded review verdict
- refuse to promote while approved work sits unmerged
- run the e2e suite once, at end of feature, only after the feature review approved, and
  reject the orchestrator's stop if it tries to finish while that suite is red
- block the commands that would make the pipeline look healthy while being broken:
  merging outside the merger, launching arbitrary containers, opening a headed browser

A test suite covers those hooks, and CI runs it on every push. That coverage is the
product: an untested guard fails silently, and one of them had been inert for months
before a test caught it. `npm test` states the current count.

## Install

```
/plugin marketplace add marmelab/AIHarness
/plugin install aiharness
```

Then declare your project's facts in `harness.config.json` at the repo root. The minimum:

```json
{
  "name": "myapp",
  "containers": { "allow": [] },
  "validation": {
    "steps": [
      {
        "id": "typecheck",
        "kind": "typecheck",
        "command": "npm run typecheck"
      },
      {
        "id": "unit",
        "kind": "unit",
        "runner": "vitest",
        "changedScoped": true
      }
    ],
    "extraForbidden": ["build", "e2e"]
  },
  "roles": {
    "orchestrator": { "model": "sonnet", "pipeline": false },
    "planner": { "model": "opus", "pipeline": true },
    "developer": { "model": "sonnet", "pipeline": true },
    "quality-reviewer": { "model": "opus", "pipeline": true },
    "merger": { "model": "haiku", "pipeline": true }
  }
}
```

This repo's own [harness.config.json](harness.config.json) is a working reference, and
`node scripts/check-config-sync.mjs` tells you whether your roles cover the hook matchers.

#### Two blocks are capability switches

`deploy` and `app` are absent from the defaults on purpose: **a capability exists if and
only if its block is present.** Omit one and the feature is simply off, with no warning,
which is the failure mode worth knowing about before you go looking for a bug.

| Block | Present | Absent |
| --- | --- | --- |
| `app` | the reviewer boots your app and verifies the feature at runtime; the developer can self-check in a browser | no runtime verification anywhere in the pipeline |
| `deploy` | the deploy-time migration round runs, gated by its own review | no migration round |

`app` takes `smokeCommand`, `portBase`, and optionally `portArg`, `strictPortArg`,
`hashRouting`, `demoMode`. `deploy` takes `relevantGlobs` (required when the block is
present).

#### Key reference

**Read by hooks.** These change what the harness enforces.

| Key | Effect |
| --- | --- |
| `validation.steps` | the chain run on every developer stop, and the commands `bash-guard` then forbids agents from running by hand. Per step: `id`, `kind`, `command` (or `runner: "vitest"` + `config` + `projects`), `changedScoped`, `extensions`, `condition.pathExists`, `formatter`, `autoCommit` |
| `validation.extraForbidden` | extra command tokens agents may not run (e.g. `build`, `e2e`) |
| `containers.allow` | container images an agent may start. `[]` blocks every launch |
| `roles.<role>.pipeline` | whether the role takes part in the ticket pipeline |
| `roles.<role>.debounce` | whether a duplicate dispatch of the role is refused |
| `roles.<role>.validate` | whether the validation chain runs on the role's stop |
| `roles` (the key names) | must cover every `SubagentStop` matcher; `check-config-sync` fails otherwise |
| `layout.src` / `.e2e` / `.adr` | where the harness looks for source, specs and ADRs |
| `worktree.provision` | how a task worktree gets its dependencies (default `npm-link`) |
| `launcher.*` | four extension points for a managed launcher; each consuming hook is inert when its key is unset. See [rules/launcher-interface.md](rules/launcher-interface.md) |

**Read by agent prompts.** Instructions, not enforcement: an agent can ignore them.

| Key | Effect |
| --- | --- |
| `app.*` | how the developer and the reviewer launch and drive your app |

**Declarative.** Validated or defaulted, but nothing reads them. Setting them changes
nothing today.

| Key | Note |
| --- | --- |
| `roles.<role>.model` | **required** (a role without a non-empty `model` string fails config loading) yet read only by tests. The model actually used comes from the agent's own frontmatter, plus the explicit `model:` the orchestrator passes on some dispatches |
| `name`, `skills.developerMenu`, `documentator.author` | no consumer; the documentator's git identity is pinned in its prompt and in `restrict-documentator-bash`, not read from here |

The harness is **opt-in per request**: nothing routes through it until you ask, with
`#harness` or "use the agent team".

### The LSP tool: interactive sessions only

The plugin declares a TypeScript language server (via `npx`, so nothing to install). It
pays off in an **interactive** session: an `LSP` call resolves a symbol through the type
system without going through the shell, where Claude Code analyses each command before
running it, costing seconds per call.

**The pipeline agents do not get it, and do not look for it.** Every harness agent is
dispatched by the orchestrator, which is itself a subagent and so cannot ask for a
foreground dispatch. They all run in the background, and a background subagent has `LSP`
pruned from its tool set: four open runtime reports, no fix, and the one confirmed
workaround is the foreground dispatch a nested subagent cannot request. Measured over one
full run: 21 agents, 0 LSP calls, 357 Bash calls.

So they answer symbol questions with [`scripts/ts-symbols.mjs`](scripts/ts-symbols.mjs),
which reaches the same TypeScript program from Bash, and [`rules/lsp-usage.md`](rules/lsp-usage.md)
tells them not to spend a turn probing for the tool. **There is nothing to configure for
the pipeline.** The rest of this section is about your own interactive sessions.

**Only one LSP server can own a file extension.** The runtime registers the first one and
the others never start; the order is undefined and there is no priority field, so a plugin
cannot win, yield, or even detect that it lost. If you also have the official
`typescript-lsp` plugin enabled, it may claim `.ts` first, and it ships no binary, so
every call answers `Executable not found in $PATH`. Nothing fails; your interactive
sessions just fall back to `grep`.

Two things report it, both automatic:

- Every session start prints one line naming the conflicting plugin and the remedy.
- `npm run check` (in this repo) fails on the same condition.

To fix it, disable the other plugin (`/plugin`, then Manage, then toggle it off) or set it
to `false` in `enabledPlugins`. Check the **user** scope (`~/.claude/settings.json`), not
just the project's: a plugin enabled there is invisible to anything the project does, which
is exactly how this went unnoticed for two full runs. Alternatively, keep the other plugin
and install the binary it expects (`npm install -g typescript-language-server typescript`).

Verify in an interactive session: an `LSP` `workspaceSymbol` call on any TypeScript symbol
should return locations rather than an error.

## What you supply, what you get

The split is documented in [HARNESS-SPLIT.md](HARNESS-SPLIT.md), including the
measurements it rests on. In short: this repo owns the hooks, the agent team, the
mechanics rules and the generic skills. You own `harness.config.json` and your domain
skills. Backends and launcher surfaces are adapters, dormant until your config activates
them.

This repo used to be a copy-paste kit aimed at working WITHOUT a harness. Five of those
files were redundant once the harness arrived and were dropped; `HARNESS-SPLIT.md` says
which, and what already owns each of them.

One caveat worth knowing before adopting it for a non-Supabase stack: four agent prompts
still inline Supabase specifics, so you would have to edit them. Moving those into the
adapter is the next planned step.

## Working on this repo

```
npm install
npm test
```

No runtime dependencies: the hooks use only node builtins, and vitest is the single
devDependency.

## Also usable without the plugin system

Copy `hooks/`, `agents/`, `rules/`, `skills/`, `commands/` and `scripts/` into your
project's `.claude/`, and merge `hooks/hooks.json` into your `.claude/settings.json`
(replacing `${CLAUDE_PLUGIN_ROOT}` with `$CLAUDE_PROJECT_DIR/.claude`). The core resolves
its own files in either layout.

One thing does not carry over: the browser tools. A plugin exposes an MCP server as
`mcp__plugin_aiharness_<server>__<tool>`, which is the name the developer and the
quality-reviewer declare, so a `.mcp.json` of your own naming the server `playwright`
grants them nothing (silently, which is how this went unnoticed for weeks). Name that
server `plugin_aiharness_playwright` to keep them.
