// Tests for scripts/check-config-sync.mjs: every SubagentStop role matcher must be a
// declared role in harness.config.json (config.roles).
//
// The script reads matchers from BOTH the plugin's own hooks/hooks.json and the
// project's .claude/settings.json, because a project consuming the plugin must declare
// the roles the plugin's matchers name. So a fixture repo starts from the plugin's role
// set and adds its own on top; a token outside that union is the drift case.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, test, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "scripts", "check-config-sync.mjs");
// hooks/test/ -> repo root. Two levels: here the harness IS the repo.
const REPO_ROOT = join(HERE, "..", "..");

// The roles this plugin's own hooks/hooks.json matchers name. A consuming project has
// to declare these, so a fixture that omits them would be testing an impossible setup.
const PLUGIN_ROLES = [
  "orchestrator",
  "planner",
  "developer",
  "simple-developer",
  "test-writer",
  "quality-reviewer",
  "merger",
];

const tmpRepos = [];
afterEach(() => {
  while (tmpRepos.length)
    rmSync(tmpRepos.pop(), { recursive: true, force: true });
});

// Build a temp repo with a harness.config.json (roles) and a settings.json
// (SubagentStop matchers), then run the script against it.
const runAgainst = ({ roles, matchers }) => {
  const repo = mkdtempSync(join(tmpdir(), "config-sync-"));
  tmpRepos.push(repo);
  mkdirSync(join(repo, ".claude"), { recursive: true });
  const rolesObj = Object.fromEntries(
    [...PLUGIN_ROLES, ...roles].map((r) => [r, { model: "sonnet" }]),
  );
  writeFileSync(
    join(repo, "harness.config.json"),
    JSON.stringify({ validation: { steps: [] }, roles: rolesObj }),
  );
  const SubagentStop = matchers.map((m) => ({ matcher: m, hooks: [] }));
  writeFileSync(
    join(repo, ".claude", "settings.json"),
    JSON.stringify({ hooks: { SubagentStop } }),
  );
  return spawnSync("node", [SCRIPT, "--app", repo], { encoding: "utf8" });
};

describe("check-config-sync", () => {
  test("all matcher tokens declared → exit 0", () => {
    const r = runAgainst({
      roles: ["reviewer-b"],
      matchers: ["developer|test-writer", "merger", "reviewer-b"],
    });
    expect(r.status).toBe(0);
  });

  test("a matcher token missing from config.roles → exit 1", () => {
    const r = runAgainst({
      roles: [],
      matchers: ["developer|ghost-role", "merger"],
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ghost-role");
  });

  test("renaming a role in BOTH files stays in sync → exit 0", () => {
    const r = runAgainst({ roles: ["dev"], matchers: ["dev", "merger"] });
    expect(r.status).toBe(0);
  });

  // The plugin's matchers are validated too, so a project that forgets a role the
  // plugin names is caught rather than silently running with a dangling matcher.
  test("a project omitting a role the plugin's matchers name → exit 1", () => {
    const repo = mkdtempSync(join(tmpdir(), "config-sync-"));
    tmpRepos.push(repo);
    writeFileSync(
      join(repo, "harness.config.json"),
      JSON.stringify({
        validation: { steps: [] },
        roles: { developer: { model: "sonnet" } },
      }),
    );
    const r = spawnSync("node", [SCRIPT, "--app", repo], { encoding: "utf8" });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("merger");
  });

  test("the committed repo is in sync → exit 0", () => {
    const r = spawnSync("node", [SCRIPT, "--app", REPO_ROOT], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});
