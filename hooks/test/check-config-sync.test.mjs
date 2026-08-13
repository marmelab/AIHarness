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

  // The plugin's own hooks.json is read alongside the project's settings.json, and it
  // now names no role at all, so it imposes no role on a consuming project: a repo
  // declaring one role and no matchers of its own is in sync.
  test("the plugin's own matchers impose no role on a project", () => {
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
    expect(r.status).toBe(0);
  });

  test("the committed repo is in sync → exit 0", () => {
    const r = spawnSync("node", [SCRIPT, "--app", REPO_ROOT], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});

// A matcher IS honoured, so a token naming no agent selects nothing and the hooks behind
// it never run — the class of failure this repo cannot afford to rediscover by accident.
// Reported, not failed. See rules/hook-authoring.md.
describe("matcher tokens that name no agent", () => {
  test("are reported as a NOTE, without failing the check", () => {
    const r = runAgainst({
      roles: [],
      matchers: ["developer|simple-developer", "merger"],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("name no agent on disk");
    expect(r.stdout).toContain("simple-developer");
    expect(r.stdout).toContain("rules/hook-authoring.md");
  });

  test("and the roles that DO have an agent are not reported", () => {
    const r = runAgainst({
      roles: [],
      matchers: ["developer|simple-developer", "merger", "planner"],
    });
    const note = r.stdout
      .split("\n")
      .find((l) => l.includes("name no agent on disk"));
    for (const role of ["developer", "quality-reviewer", "merger", "planner"]) {
      expect(note).not.toContain(` ${role},`);
      expect(note.endsWith(` ${role}.`)).toBe(false);
    }
  });
});

// A bare role token cannot match the namespaced `agent_type` a plugin install reports,
// which is how every SubagentStop hook came to be skipped on every real stop of every
// plugin-only run. Reported rather than failed, because a project that vendored the
// harness with its own bare-named agents does match on them.
describe("SubagentStop matchers that filter by role", () => {
  test("are reported as a NOTE naming the plugin hazard", () => {
    const r = runAgainst({
      roles: [],
      matchers: ["quality-reviewer|merger", "orchestrator"],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("filter by role");
    expect(r.stdout).toContain("quality-reviewer|merger");
    expect(r.stdout).toContain("aiharness:developer");
  });

  test("a role-agnostic matcher is not reported", () => {
    const r = runAgainst({ roles: [], matchers: [".*", ".*"] });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("filter by role");
  });

  test("this repo's own wiring is role-agnostic", () => {
    const r = spawnSync("node", [SCRIPT, "--app", REPO_ROOT], {
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain("filter by role");
  });
});
