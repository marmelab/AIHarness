// Tests for block-docker-containers.mjs — blocks container launches (run/create/
// start, compose up) for any caller including the main session, unless the command
// references a stack the project declared in harness.config.json `containers.allow`.
// Blocks are decision JSON on stdout with exit 0; allowed commands produce no decision.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, test, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "block-docker-containers.mjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "block-docker-tmp-"));
const repos = [];

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  for (const r of repos) rmSync(r, { recursive: true, force: true });
});

// A throwaway repo whose harness.config.json we control, so the allowed set is proven
// to come from config rather than from a hardcoded vendor name.
const repoAllowing = (allow) => {
  const repo = mkdtempSync(join(tmpdir(), "block-docker-repo-"));
  repos.push(repo);
  if (allow !== null)
    writeFileSync(
      join(repo, "harness.config.json"),
      JSON.stringify({ containers: { allow }, roles: {} }),
    );
  return repo;
};

const SUPABASE_REPO = repoAllowing(["supabase"]);
const EMPTY_REPO = repoAllowing([]);
const NO_CONFIG_REPO = repoAllowing(null);

const runHook = (agent, command, repo = SUPABASE_REPO) => {
  const env = { ...process.env, HARNESS_TMP_ROOT: tmpRoot, APP_DIR: repo };
  delete env.CLAUDE_AGENT_NAME;
  delete env.CLAUDE_PROJECT_DIR;
  const input = JSON.stringify({
    tool_name: "Bash",
    agent_type: agent,
    session_id: "test-1234",
    tool_input: { command },
  });
  return spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
};

const isBlocked = (r) => r.stdout.includes('"decision":"block"');

describe("block-docker-containers hook", () => {
  describe("container launches → blocked (any caller, incl. main session)", () => {
    const blocked = [
      ["", "docker run -it ubuntu bash"],
      ["", "docker run -v /home:/host alpine"],
      ["", "docker create nginx"],
      ["", "docker start my-stopped-container"],
      ["", "docker container run redis"],
      ["", "docker compose up -d"],
      ["", "docker-compose up"],
      ["developer", "docker run hello-world"],
      ["", "echo hi && docker run busybox"],
    ];

    test.each(blocked)("%s running '%s' → blocked", (agent, command) => {
      const r = runHook(agent, command);
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(true);
    });
  });

  describe("a declared stack's containers → allowed", () => {
    const allowed = [
      ["", "docker run supabase/postgres:15"],
      ["", "docker start supabase_db_myapp"],
      ["", "docker compose -f supabase/docker-compose.yml up -d"],
      ["", "npx supabase start"],
      ["", "make start"],
    ];

    test.each(allowed)("%s running '%s' → allowed", (agent, command) => {
      const r = runHook(agent, command);
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(false);
    });
  });

  // The whole point of the config seam: the vendor name is data, not code.
  describe("the allowed set is config-driven", () => {
    test("an empty allow list blocks the very command the declared set permits", () => {
      expect(
        isBlocked(runHook("", "docker run supabase/postgres:15", EMPTY_REPO)),
      ).toBe(true);
    });

    test("no config at all also blocks (safe baseline, never fail-open)", () => {
      expect(
        isBlocked(
          runHook("", "docker run supabase/postgres:15", NO_CONFIG_REPO),
        ),
      ).toBe(true);
    });

    test("a different declared stack is honoured", () => {
      const repo = repoAllowing(["localstack"]);
      expect(
        isBlocked(runHook("", "docker run localstack/localstack", repo)),
      ).toBe(false);
      expect(
        isBlocked(runHook("", "docker run supabase/postgres:15", repo)),
      ).toBe(true);
    });

    test("the block message names what is currently allowed", () => {
      const r = runHook("", "docker run ubuntu");
      expect(r.stdout).toContain("supabase");
      expect(r.stdout).toContain("containers.allow");
    });
  });

  describe("non-launch docker verbs → allowed", () => {
    const allowed = [
      "docker ps",
      "docker logs my-container",
      "docker stop my-container",
      "docker rm my-container",
      "docker exec my-container ls",
      "docker images",
      "docker version",
    ];

    test.each(allowed)("'%s' → allowed", (command) => {
      const r = runHook("", command);
      expect(isBlocked(r)).toBe(false);
    });
  });

  test("empty command → allowed", () => {
    const r = runHook("", "");
    expect(r.status).toBe(0);
    expect(isBlocked(r)).toBe(false);
  });
});
