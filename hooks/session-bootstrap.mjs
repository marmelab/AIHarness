#!/usr/bin/env node
// SessionStart — bootstrap the harness session context so the orchestrator (or the
// main thread acting as one) can run on ANY Claude Code surface (CLI, VS Code
// extension, desktop), not only via a launch script that injects
// --append-system-prompt.
//
// It injects `<session_dir>` via hookSpecificOutput.additionalContext, derived
// from the REAL session id the harness assigns. Because every other hook
// (setup-worktree, merger, ...) also keys off that same real session id, the
// alignment invariant `basename(session_dir) == session_id` holds by construction
// — no minted UUID, no forced --session-id.

// Pure env-inspection + additionalContext: no MCP calls (MCP may be disabled in
// hosted/headless runs), no git mutation, never throws.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHookContext } from "./lib/context.mjs";
import { harnessFile, REPO } from "./lib/paths.mjs";
import { detectInflight } from "./lib/session-state.mjs";
import { sessionDirFromEnv } from "./lib/config.mjs";

// A managed launcher owns the session context — stay out of its way.
if (sessionDirFromEnv()) process.exit(0);

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  // no payload → nothing to inject
  process.exit(0);
}

const ctx = createHookContext(input, "session-bootstrap");

// Use the SAME per-session dir that setup-worktree builds its worktrees under
// (ctx.sessionDir = /tmp/<sanitized repo>/<session_id>, via context.mjs). Its
// BASENAME is the real session id — what the orchestrator turns into
// SESSION_SHORT_ID and WORKTREE_BASE — so the alignment holds and tickets/logs
// share the one session namespace instead of a separate root.
const sessionDir = ctx.sessionDir;
try {
  mkdirSync(sessionDir, { recursive: true });
} catch {
  // best-effort: the orchestrator/agents recreate it as needed
}

// The harness's own scripts and the repo root, resolved HERE and written to a file the
// agents can source. A hook always has the env to resolve both; a subagent's shell does
// not. `$CLAUDE_PROJECT_DIR` was observed EMPTY in one, so a prompt that spelled a path as
// `$CLAUDE_PROJECT_DIR/.claude/scripts/x.mjs` resolved to `/.claude/scripts/x.mjs` and
// died with module-not-found. That literal is wrong twice over: under plugin distribution
// the scripts live in the plugin, not in the project's `.claude/`.
//
// harnessFile() already knows both layouts (CLAUDE_PLUGIN_ROOT, else <repo>/.claude), so
// one sourced line replaces every hand-spelled path in agents/*.md.
try {
  writeFileSync(
    join(sessionDir, "harness-env.sh"),
    [
      "# Written by session-bootstrap. Source it before invoking a harness script:",
      '#   source "<TICKETS_DIR>/harness-env.sh"',
      "# HARNESS_SCRIPTS is the harness's own scripts dir in whichever layout is installed;",
      "# HARNESS_REPO is the project root. Neither depends on env a subagent shell may lack.",
      `export HARNESS_SCRIPTS=${JSON.stringify(dirname(harnessFile("scripts", "e2e-smoke.sh")))}`,
      `export HARNESS_REPO=${JSON.stringify(REPO)}`,
      `export HARNESS_SESSION_DIR=${JSON.stringify(sessionDir)}`,
      "",
    ].join("\n"),
  );
} catch {
  // best-effort: an agent that cannot source it falls back to its own resolution
}

ctx.log(`SESSION-BOOTSTRAP session_dir=${sessionDir}`);

// Resume banner: on a RESUMED session (same id → same namespace), the previous
// orchestrator process is gone and nothing re-launches it, so an interrupted
// harness would otherwise sit dead. If THIS session has in-flight harness state
// on disk/git, tell the main thread to re-dispatch a FRESH recovery orchestrator
// (never SendMessage the dead one). Keyed only on this session id — a fresh or
// unrelated concurrent session has no state under its id and gets no banner.
let resume = "";
try {
  const { inflight, phase } = detectInflight(ctx);
  if (inflight === true) {
    ctx.log(`SESSION-BOOTSTRAP resume-available phase=${phase}`);
    resume =
      `\n<harness_resume>` +
      `An interrupted harness session was detected for THIS session (short id \`${ctx.sessionShort}\`), paused at: ${phase}. ` +
      `Its orchestrator process ended when the window last closed; nothing is running now. ` +
      `To resume, dispatch a FRESH orchestrator with <intent>recovery</intent> and this same session_dir. ` +
      `Do NOT SendMessage a previous orchestrator (it is dead). See CLAUDE.md "Resuming after a restart".` +
      `</harness_resume>`;
  }
} catch {
  // detection must never break bootstrap
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: `<session_dir>${sessionDir}</session_dir>${resume}`,
    },
  }) + "\n",
);
process.exit(0);
