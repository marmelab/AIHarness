#!/usr/bin/env node
// Verify that every agent-role referenced by a SubagentStop matcher is a declared role
// in harness.config.json (config.roles). Claude Code requires those matchers to be
// literal strings (they cannot be computed from the config), so this check is the bridge
// that keeps the two in sync: rename a role in config AND in the matchers -> the token
// still resolves, pass; rename it in config only -> the stale token is not a config
// role, fail.
//
// The matchers live in the plugin's own hooks/hooks.json when the harness is installed
// as a plugin, and in the project's .claude/settings.json when it was copied in. Both
// are read, and a role token from either must resolve, so the check works in either
// layout and in a mixed one (plugin hooks plus project-only hooks).
//
// Usage: node scripts/check-config-sync.mjs [--app <repo>]
// Exit 0 = in sync; exit 1 = drift (prints the offending tokens).

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, roleNames } from "../hooks/lib/config.mjs";

function resolveRepo(argv) {
  const flag = argv.indexOf("--app");
  if (flag !== -1 && argv[flag + 1]) return argv[flag + 1];
  return process.env.APP_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

// SubagentStop matchers are role tokens (possibly `a|b`); PreToolUse/PostToolUse
// matchers are tool names (Bash, Agent, Write|Edit) and are NOT roles, so only
// SubagentStop is checked here.
function settingsRoleTokens(settings) {
  const entries = settings.hooks?.SubagentStop ?? [];
  const tokens = new Set();
  for (const entry of entries) {
    const matcher = entry.matcher;
    if (!matcher || typeof matcher !== "string") continue;
    for (const t of matcher
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)) {
      tokens.add(t);
    }
  }
  return [...tokens];
}

// Every place SubagentStop matchers can be declared, in the order they are searched.
// PLUGIN_HOOKS is relative to this script's own package, so it is found whether the
// harness runs as an installed plugin or from a checkout of this repo.
const HERE = dirname(fileURLToPath(import.meta.url));
const sources = (repo) => [
  { label: "hooks/hooks.json", path: join(HERE, "..", "hooks", "hooks.json") },
  {
    label: ".claude/settings.json",
    path: join(repo, ".claude", "settings.json"),
  },
];

export function checkConfigSync(repo) {
  const found = [];
  for (const src of sources(repo)) {
    if (!existsSync(src.path)) continue;
    try {
      found.push({ ...src, json: JSON.parse(readFileSync(src.path, "utf8")) });
    } catch (e) {
      return { ok: false, error: `${src.label} is not valid JSON: ${e.message}` };
    }
  }
  if (!found.length) {
    return {
      ok: false,
      error: `no hook declarations found (looked for ${sources(repo)
        .map((s) => s.path)
        .join(", ")})`,
    };
  }
  const settings = {
    hooks: {
      SubagentStop: found.flatMap((f) => f.json.hooks?.SubagentStop ?? []),
    },
  };
  let roles;
  try {
    roles = new Set(roleNames(loadConfig(repo)));
  } catch (e) {
    return { ok: false, error: e.message };
  }
  const tokens = settingsRoleTokens(settings);
  const missing = tokens.filter((t) => !roles.has(t));
  return {
    ok: missing.length === 0,
    missing,
    tokens,
    roles: [...roles],
    agentless: agentlessTokens(tokens),
  };
}

// Matcher tokens that name a declared role NO agent is dispatched under. Reported, not
// failed: a role can legitimately exist in the config without its own agent file
// (simple-developer is the SIMPLE flow's validate/debounce identity, dispatched as
// `developer`). It matters because the matcher is inert TODAY for a different reason
// (agent_type is empty at SubagentStop, so nothing is filtered at all), and the day the
// runtime starts honouring matchers this token will select nothing while looking correct.
// See rules/hook-authoring.md.
function agentlessTokens(tokens) {
  let agents;
  try {
    agents = new Set(
      readdirSync(join(HERE, "..", "agents"))
        .filter((f) => f.endsWith(".md"))
        .map((f) => f.replace(/\.md$/, "")),
    );
  } catch {
    return []; // no agents dir to compare against
  }
  return tokens.filter((t) => !agents.has(t));
}

// Run as CLI when invoked directly (not when imported by a test).
if (import.meta.url === `file://${process.argv[1]}`) {
  const repo = resolveRepo(process.argv.slice(2));
  const r = checkConfigSync(repo);
  if (r.error) {
    console.error(`check-config-sync: ${r.error}`);
    process.exit(1);
  }
  if (!r.ok) {
    console.error(
      `check-config-sync: settings.json SubagentStop matcher(s) reference roles not in harness.config.json: ${r.missing.join(", ")}.\n` +
        `Declared roles: ${r.roles.join(", ")}.\n` +
        `Rename the role in BOTH files, or add it to config.roles.`,
    );
    process.exit(1);
  }
  if (r.agentless.length) {
    process.stdout.write(
      `check-config-sync: NOTE ${r.agentless.length} matcher token(s) name no agent on disk: ${r.agentless.join(", ")}.\n` +
        `  Harmless while SubagentStop matchers filter nothing (agent_type is empty), and inert the day they do.\n` +
        `  See rules/hook-authoring.md "The SubagentStop matchers do not filter".\n`,
    );
  }
  process.stdout.write(
    `check-config-sync: OK (${r.tokens.length} role matcher(s) all declared)\n`,
  );
  process.exit(0);
}
