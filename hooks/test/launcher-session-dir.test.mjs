// Tests for config.launcher.sessionDirEnv, the documented extension point that names
// the env var carrying a managed launcher's session dir.
//
// Every consumer used to read process.env.CHAT_SESSION_DIR directly, so declaring a
// different name changed nothing and nothing errored: the review verdict flags and the
// e2e result were written to, and read from, the recomputed /tmp/<repo>/<id> path while
// the launcher looked in its own dir.
//
// Run in a CHILD process, not in-process: the repo root is resolved once at module load
// from APP_DIR, so a test that sets it afterwards would still be reading this repo's
// own config and would pass no matter what the helper did.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");

let TMP, REPO, probe;

const PROBE = `
import { sessionDirEnvName, sessionDirFromEnv, loadConfig } from ${JSON.stringify(join(LIB, "config.mjs"))};
import { e2eResultPath } from ${JSON.stringify(join(LIB, "e2e-result.mjs"))};
import { reviewFlag, reviewsDir, validationGaveUpFlag } from ${JSON.stringify(join(LIB, "reviews.mjs"))};
const ctx = { sessionDir: "/tmp/recomputed/session-1" };
let envName = "";
try {
  envName = sessionDirEnvName(loadConfig());
} catch {
  envName = "(config error)";
}
process.stdout.write(
  JSON.stringify({
    envName,
    sessionDir: sessionDirFromEnv(),
    reviewsDir: reviewsDir(ctx),
    reviewFlag: reviewFlag(ctx, "TASK-001", "quality-reviewer"),
    gaveUp: validationGaveUpFlag(ctx, "TASK-001"),
    e2e: e2eResultPath(ctx),
  }),
);
`;

const writeConfig = (launcher) =>
  writeFileSync(
    join(REPO, "harness.config.json"),
    JSON.stringify({
      validation: { steps: [] },
      roles: {},
      ...(launcher ? { launcher } : {}),
    }),
  );

const probeWith = (env = {}) => {
  const clean = { ...process.env, APP_DIR: REPO };
  delete clean.CHAT_SESSION_DIR;
  delete clean.CRM_BUILDER_SESSION;
  const r = spawnSync("node", [probe], {
    env: { ...clean, ...env },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "launcher-session-dir-"));
  REPO = join(TMP, "repo");
  mkdirSync(REPO, { recursive: true });
  probe = join(TMP, "probe.mjs");
  writeFileSync(probe, PROBE);
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("the env var carrying the launcher's session dir", () => {
  test("defaults to CHAT_SESSION_DIR when no launcher is declared", () => {
    writeConfig(null);
    expect(probeWith({ CHAT_SESSION_DIR: "/managed" })).toMatchObject({
      envName: "CHAT_SESSION_DIR",
      sessionDir: "/managed",
    });
  });

  test("is whatever the config declares, and CHAT_SESSION_DIR is then ignored", () => {
    writeConfig({ sessionDirEnv: "CRM_BUILDER_SESSION" });
    expect(
      probeWith({
        CRM_BUILDER_SESSION: "/managed/session",
        CHAT_SESSION_DIR: "/should/be/ignored",
      }),
    ).toMatchObject({
      envName: "CRM_BUILDER_SESSION",
      sessionDir: "/managed/session",
    });
  });

  test("is empty with no managed launcher, so callers use ctx.sessionDir", () => {
    writeConfig(null);
    expect(probeWith().sessionDir).toBe("");
  });

  // Fail open on an unreadable config: a hook that cannot load one must still find the
  // launcher's dir under the default name rather than silently resolving nothing.
  test("falls back to CHAT_SESSION_DIR when the config cannot be read", () => {
    writeFileSync(join(REPO, "harness.config.json"), "{ not json");
    expect(probeWith({ CHAT_SESSION_DIR: "/managed" }).sessionDir).toBe(
      "/managed",
    );
  });
});

// The artifacts a launcher silently loses when the indirection is skipped.
describe("the session-scoped artifacts follow the declared variable", () => {
  test("verdict flags, the give-up marker and the e2e result all land there", () => {
    writeConfig({ sessionDirEnv: "CRM_BUILDER_SESSION" });
    expect(
      probeWith({ CRM_BUILDER_SESSION: "/managed/session" }),
    ).toMatchObject({
      reviewsDir: "/managed/session/reviews",
      reviewFlag: "/managed/session/reviews/TASK-001-quality-reviewer",
      gaveUp: "/managed/session/validation-gave-up/TASK-001",
      e2e: "/managed/session/e2e-result.json",
    });
  });

  test("and fall back to the recomputed dir with no managed launcher", () => {
    writeConfig({ sessionDirEnv: "CRM_BUILDER_SESSION" });
    expect(probeWith()).toMatchObject({
      reviewsDir: "/tmp/recomputed/session-1/reviews",
      gaveUp: "/tmp/recomputed/session-1/validation-gave-up/TASK-001",
      e2e: "/tmp/recomputed/session-1/e2e-result.json",
    });
  });
});
