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

441 tests cover those hooks. That number matters: the guards are the product, and an
untested guard fails silently. One of them had been inert for months before a test caught
it.

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

The harness is **opt-in per request**: nothing routes through it until you ask, with
`#harness` or "use the agent team".

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
