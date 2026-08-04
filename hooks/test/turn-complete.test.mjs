// Tests for turn-complete.mjs — the Stop hook that drops a per-session sentinel a
// managed launcher polls to know the turn ended. Must always exit 0 (a Stop hook never
// blocks) and never throw on a missing/malformed payload.
//
// The sentinel dir is pinned per test rather than inherited from the host repo's config:
// the core must not depend on whichever project hosts it, and the previous version wrote
// into the shared real /tmp/pty-sentinels.

import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "turn-complete.mjs");
const TMP = mkdtempSync(join(tmpdir(), "turn-complete-"));

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// A repo whose config declares (or omits) the launcher extension point.
const repoWith = (launcher) => {
  const repo = mkdtempSync(join(TMP, "repo-"));
  writeFileSync(
    join(repo, "harness.config.json"),
    JSON.stringify({ validation: { steps: [] }, roles: {}, launcher }),
  );
  return repo;
};

const run = (input, repo) => {
  const env = { ...process.env };
  delete env.CLAUDE_PROJECT_DIR;
  if (repo) env.APP_DIR = repo;
  return spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
};

describe("turn-complete", () => {
  test("creates the per-session sentinel and exits 0", () => {
    const dir = join(TMP, "sentinels");
    const repo = repoWith({ turnSentinelDir: dir });
    const sid = "turn-complete-test-7e3a9f21";
    const r = run(JSON.stringify({ session_id: sid }), repo);
    expect(r.status).toBe(0);
    expect(existsSync(join(dir, `pty-turn-done-${sid}`))).toBe(true);
  });

  test("no session id → no throw, exits 0", () => {
    const repo = repoWith({ turnSentinelDir: join(TMP, "sentinels-b") });
    expect(run(JSON.stringify({}), repo).status).toBe(0);
    expect(existsSync(join(TMP, "sentinels-b"))).toBe(false);
  });

  test("malformed payload → no throw, exits 0", () => {
    expect(run("not json", repoWith({})).status).toBe(0);
  });

  test("inert when config.launcher.turnSentinelDir is unset (no launcher)", () => {
    const repo = repoWith({});
    const sid = "turn-complete-inert-9c1d";
    const r = run(JSON.stringify({ session_id: sid }), repo);
    expect(r.status).toBe(0);
    // Nothing written anywhere: the hook creates no directory and hardcodes no path.
    expect(existsSync(join("/tmp/pty-sentinels", `pty-turn-done-${sid}`))).toBe(
      false,
    );
  });
});
