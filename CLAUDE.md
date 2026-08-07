# AIHarness

This repo IS the harness. It ships as a Claude Code plugin: `hooks/`, `agents/`, `rules/`,
`skills/`, `commands/`, `scripts/` sit at the root (plugin layout), not under `.claude/`.

- `.claude-plugin/plugin.json` + `marketplace.json` — the repo is its own marketplace.
- `hooks/hooks.json` — the hook registrations, paths via `${CLAUDE_PLUGIN_ROOT}`.
- `harness.config.json` — this repo's own contract, and the reference a consumer copies.
- `HARNESS-SPLIT.md` — what belongs to the core, to an adapter, or to a project, and the
  measurements that decision rests on. Read it before moving anything between layers.
- `templates/` — the `CLAUDE.md` / `AGENTS.md` a consuming project starts from.

## Commands

```
npm install
npm test                          # 768 tests, the hooks' regression net
node scripts/check-config-sync.mjs  # every hook matcher resolves to a declared role
```

No runtime dependencies: the hooks use node builtins only.

## Working here

The guards ARE the product, so a change to a hook without a test is not done. That is not
a style preference: `completion-invariant` looked for verdict flags in a directory that
never existed and was inert for months, because it had no test and a guard that never
fires reports nothing.

`rules/hook-authoring.md` carries the rules that came out of nine defects found by running the
harness rather than reading it. Read it before changing a hook; it is scoped to `hooks/**` so it
loads only then.

Two invariants to preserve:

- **Fail closed on identity, fail open on ignorance.** A guard that knows who the caller is
  refuses when in doubt; a guard that cannot know (an unparseable payload on a hook that
  runs for every caller) must let the command through rather than wedge every agent.
- **Project facts belong in `harness.config.json`.** If a hook needs to know a vendor, a
  port or a command, it reads the config. The one place this is still violated is four
  agent prompts, tracked at the end of `HARNESS-SPLIT.md`.
