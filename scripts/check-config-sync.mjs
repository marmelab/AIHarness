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

// Claude Code compares a matcher of plain alphanumerics + `|,-_` as an EXACT match
// against the `|`-separated list, and routes anything containing a regex metacharacter
// through an unanchored RegExp. So only the first shape carries role tokens, and only
// the second can select every agent whatever its namespace.
const isRoleTokenList = (matcher) => /^[\w|,-]+$/.test(matcher);
const selectsEveryAgent = (matcher) => /^(\.\*|\*|\.\+)$/.test(matcher);

// SubagentStop matchers are role tokens (possibly `a|b`); PreToolUse/PostToolUse
// matchers are tool names (Bash, Agent, Write|Edit) and are NOT roles, so only
// SubagentStop is checked here.
function settingsRoleTokens(settings) {
  const entries = settings.hooks?.SubagentStop ?? [];
  const tokens = new Set();
  for (const entry of entries) {
    const matcher = entry.matcher;
    if (!matcher || typeof matcher !== "string") continue;
    if (!isRoleTokenList(matcher)) continue;
    for (const t of matcher
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean)) {
      tokens.add(t);
    }
  }
  return [...tokens];
}

// SubagentStop matchers that filter by ROLE. Reported, not failed: a project that
// vendored the harness under .claude/ with its own bare-named agents does match on
// them. It is reported because a bare role token cannot match the NAMESPACED
// `agent_type` a plugin install reports (`aiharness:developer`), so the day such a
// project enables the plugin every hook behind that matcher stops running, in silence.
function roleFilteringMatchers(settings) {
  return (settings.hooks?.SubagentStop ?? [])
    .map((e) => e.matcher)
    .filter(
      (m) =>
        typeof m === "string" &&
        m &&
        !selectsEveryAgent(m) &&
        isRoleTokenList(m),
    );
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
      return {
        ok: false,
        error: `${src.label} is not valid JSON: ${e.message}`,
      };
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
    roleFiltering: roleFilteringMatchers(settings),
  };
}

// Matcher tokens that name a declared role NO agent is dispatched under. Reported, not
// failed: a role can legitimately exist in the config without its own agent file
// (simple-developer is the SIMPLE flow's validate/debounce identity, dispatched as
// `developer`). It matters because such a token selects nothing at all — matchers ARE
// honoured — so the hooks behind it never run. See rules/hook-authoring.md.
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
        `  A SubagentStop matcher IS honoured, so a token no agent answers to selects nothing.\n` +
        `  See rules/hook-authoring.md "The SubagentStop matchers are honoured".\n`,
    );
  }
  if (r.roleFiltering.length) {
    process.stdout.write(
      `check-config-sync: NOTE ${r.roleFiltering.length} SubagentStop matcher(s) filter by role: ${r.roleFiltering.join(", ")}.\n` +
        `  A bare role token cannot match the namespaced agent_type a PLUGIN install reports\n` +
        `  (aiharness:developer), so those hooks would stop running the day this project\n` +
        `  consumes the harness as a plugin. Use ".*" and let the hook gate on its own role.\n`,
    );
  }
  process.stdout.write(
    `check-config-sync: OK (${r.tokens.length} role matcher(s) all declared)\n`,
  );
  process.exit(0);
}
