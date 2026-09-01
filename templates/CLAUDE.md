@AGENTS.md

# <Project name>

## Specific to Claude Code

- The agent harness ships as a plugin: install it with
  `/plugin marketplace add marmelab/AIHarness` then `/plugin install aiharness`.
  Its rules, skills, sub-agents and hooks come from the plugin, not from this repo.
- Project-only rules and skills: `.claude/rules/`, `.claude/skills/`
- Harness contract: `harness.config.json` (validation steps, roles, allowed containers,
  deploy adapter, app smoke). This is the one file the harness reads for project facts.
- Active output style: `<style name>` (`.claude/styles/<style name>.md`)

## Agent harness

Code-change requests can run through the harness: subagents (planner, developer,
quality-reviewer, merger, documentator) implementing the change in git worktrees under
hook enforcement. **Opt-in, off by default**: `#harness` (or "use the agent team") routes
a request through the orchestrator; otherwise the main thread implements it itself.

Gate levels: `gate=none|migration|plan|waves`, default `plan` (pauses after planning for
ticket review, and before applying a database migration).

**Scope the request before dispatching.** On every `#harness` request, run
`Skill({skill: "grill-me"})` in the main thread first. It decides for itself whether
questions are needed and exits in one line when the scope is already precise, so invoke it
unconditionally rather than judging first. Fold its answers into the dispatch prompt.

This is a main-thread step: an agent that asks a question ends its turn, and the answer
reaches a fresh agent with no memory of asking. The planner is not a substitute, it stops
for at most one question and only when a request is too vague to decompose at all.
