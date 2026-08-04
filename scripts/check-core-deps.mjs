#!/usr/bin/env node
// Verify the core imports nothing but node builtins and relative paths, so the plugin
// stays installable in any project without pulling a dependency tree.
//
// Anchored to real import/export statements at line start, NOT a text grep: a prose
// comment containing `from "..."` would otherwise fail the check (it did).
//
// Usage: node scripts/check-core-deps.mjs
// Exit 0 = clean; 1 = a core file imports a third-party module.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Test files may use vitest; the shipped core may not use anything.
const CORE_DIRS = ["hooks", "hooks/lib", "scripts"];
const IMPORT_RE = /^\s*(?:import|export)\b[^;\n]*?\bfrom\s+["']([^"']+)["']/gm;

const isAllowed = (spec) =>
  spec.startsWith("node:") || spec.startsWith("./") || spec.startsWith("../");

const offenders = [];
for (const dir of CORE_DIRS) {
  const abs = join(ROOT, dir);
  for (const f of readdirSync(abs)) {
    if (!/\.mjs$/.test(f)) continue;
    const rel = `${dir}/${f}`;
    const body = readFileSync(join(abs, f), "utf8");
    for (const m of body.matchAll(IMPORT_RE)) {
      if (!isAllowed(m[1])) offenders.push(`${rel}: ${m[1]}`);
    }
  }
}

if (offenders.length) {
  console.error(
    `check-core-deps: ${offenders.length} third-party import(s) in the core:`,
  );
  for (const o of offenders) console.error(`  ${o}`);
  process.exit(1);
}

console.log(
  `check-core-deps: OK (${CORE_DIRS.join(", ")} import only node builtins and relative paths)`,
);
