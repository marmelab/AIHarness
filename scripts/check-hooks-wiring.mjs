#!/usr/bin/env node
// Verify hooks/hooks.json against the files on disk, in both directions.
//
// A path typo in hooks.json is INVISIBLE at runtime: Claude Code registers the hook,
// the command fails to resolve, and the guard silently never fires. That is the same
// failure mode as the orphan invariant that sat inert for months, so it gets a check.
//
// Usage: node scripts/check-hooks-wiring.mjs
// Exit 0 = every registration resolves and every hook is registered; 1 = drift.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const HOOKS_DIR = join(ROOT, "hooks");
const manifest = JSON.parse(readFileSync(join(HOOKS_DIR, "hooks.json"), "utf8"));

// `${CLAUDE_PLUGIN_ROOT}/hooks/x.mjs` -> hooks/x.mjs
const registered = new Set();
const unresolved = [];
for (const entries of Object.values(manifest.hooks ?? {})) {
  for (const entry of entries) {
    for (const h of entry.hooks ?? []) {
      const m = String(h.command ?? "").match(
        /\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+\.mjs)/,
      );
      if (!m) {
        unresolved.push(h.command);
        continue;
      }
      registered.add(m[1]);
      if (!existsSync(join(ROOT, m[1]))) unresolved.push(m[1]);
    }
  }
}

// Hooks on disk that nothing registers. Not fatal on its own (a hook can be invoked by
// another hook), but it is nearly always a forgotten registration, so it fails the check
// and an intentional exception is added here explicitly.
const INTENTIONALLY_UNREGISTERED = new Set([]);
const onDisk = readdirSync(HOOKS_DIR).filter((f) => f.endsWith(".mjs"));
const orphans = onDisk
  .map((f) => `hooks/${f}`)
  .filter((p) => !registered.has(p) && !INTENTIONALLY_UNREGISTERED.has(p));

// Same class of failure for the MCP servers the plugin declares: a bad path means the
// server never starts, and the only symptom is a tool that silently is not there.
const mcpPath = join(ROOT, ".mcp.json");
if (existsSync(mcpPath)) {
  const servers = JSON.parse(readFileSync(mcpPath, "utf8"));
  for (const [name, def] of Object.entries(servers)) {
    for (const arg of def.args ?? []) {
      const m = String(arg).match(/\$\{CLAUDE_PLUGIN_ROOT\}\/(\S+)/);
      if (m && !existsSync(join(ROOT, m[1])))
        unresolved.push(`.mcp.json ${name}: ${m[1]}`);
    }
  }
}

let failed = false;
if (unresolved.length) {
  console.error(
    `check-hooks-wiring: ${unresolved.length} registration(s) do not resolve to a file:`,
  );
  for (const u of unresolved) console.error(`  ${u}`);
  failed = true;
}
if (orphans.length) {
  console.error(
    `check-hooks-wiring: ${orphans.length} hook(s) on disk are registered nowhere:`,
  );
  for (const o of orphans) console.error(`  ${o}`);
  failed = true;
}
if (failed) process.exit(1);

console.log(
  `check-hooks-wiring: OK (${registered.size} registration(s), ${onDisk.length} hook(s) on disk)`,
);
