// The plugin is installed from its own directory: Claude Code copies `plugins/run-anatomy/`
// and nothing else. An import that climbs out of it resolves in this repository, passes
// every test here, and fails only once installed.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const REPO = resolve(PLUGIN, "..", "..");

const filesUnder = (dir, keep) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory()
      ? filesUnder(join(dir, e.name), keep)
      : keep(e.name)
        ? [join(dir, e.name)]
        : [],
  );

const RELATIVE_SPEC = /\b(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']*)["']/g;

describe("run-anatomy is self-contained", () => {
  test("no shipped module imports anything outside the plugin", () => {
    const modules = filesUnder(
      PLUGIN,
      (n) => /\.(m?js)$/.test(n) && !n.endsWith(".test.mjs"),
    );
    expect(modules.length).toBeGreaterThan(10);
    const escapes = [];
    for (const file of modules) {
      for (const m of readFileSync(file, "utf8").matchAll(RELATIVE_SPEC)) {
        const target = resolve(dirname(file), m[1]);
        if (relative(PLUGIN, target).startsWith(".."))
          escapes.push(`${relative(PLUGIN, file)}: ${m[1]}`);
      }
    }
    expect(escapes).toEqual([]);
  });

  test("every script a command runs ships with the plugin", () => {
    const commands = filesUnder(join(PLUGIN, "commands"), (n) =>
      n.endsWith(".md"),
    );
    const scripts = commands.flatMap((file) =>
      [
        ...readFileSync(file, "utf8").matchAll(
          /\$\{CLAUDE_PLUGIN_ROOT\}\/([\w/.-]+\.mjs)/g,
        ),
      ].map((m) => m[1]),
    );
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts)
      expect(() => readFileSync(join(PLUGIN, script))).not.toThrow();
  });

  // The harness and the plugin each need these, and neither can import from the other
  // in every layout, so the plugin carries copies. A copy that drifts gives the two a
  // different answer to the same question: a Bash call bucketed twice, a turn priced twice.
  test.each([
    ["scripts/lib/bash-classify.mjs", "hooks/lib/bash-classify.mjs"],
    ["scripts/lib/pricing.mjs", "scripts/lib/pricing.mjs"],
  ])("%s is the harness's %s, byte for byte", (copy, source) => {
    expect(readFileSync(join(PLUGIN, copy), "utf8")).toBe(
      readFileSync(join(REPO, source), "utf8"),
    );
  });
});
