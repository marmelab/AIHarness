// getBaseBranch: which ref a hook diffs against, and the window where that is
// whatever the human has checked out.
//
// The anchor (session-base/<short>) is a fixed commit, so "what has this session
// changed" keeps meaning the same thing all session. The repo HEAD does not, and a
// human switching branches used to move every hook's diff base with no trace.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const LIB = join(dirname(fileURLToPath(import.meta.url)), "..", "lib");
const SHORT = "ba5eb00c";

let TMP, REPO, probe;

const PROBE = `
import { getBaseBranch } from ${JSON.stringify(join(LIB, "git.mjs"))};
process.stdout.write(
  JSON.stringify({
    withCtx: getBaseBranch({ sessionShort: ${JSON.stringify(SHORT)} }),
    withoutCtx: getBaseBranch(),
  }),
);
`;

const g = (...a) => spawnSync("git", ["-C", REPO, ...a], { encoding: "utf8" });

const ask = () => {
  const r = spawnSync("node", [probe], {
    env: { ...process.env, APP_DIR: REPO },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout);
};

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "base-branch-"));
  REPO = join(TMP, "repo");
  mkdirSync(REPO, { recursive: true });
  probe = join(TMP, "probe.mjs");
  writeFileSync(probe, PROBE);
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(REPO, "f.txt"), "seed\n");
  g("add", "-A");
  g("commit", "-qm", "seed");
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("before the session anchor exists", () => {
  test("the answer is the repo's current HEAD", () => {
    expect(ask().withCtx).toBe("main");
  });

  // The exposure window, stated as a test rather than only as a comment: in it, a
  // human switching branches silently changes what every hook treats as the base.
  test("and it moves when the human checks out another branch", () => {
    g("checkout", "-q", "-b", "feature/x");
    expect(ask().withCtx).toBe("feature/x");
  });
});

describe("once the session anchor exists", () => {
  beforeEach(() => g("branch", `session-base/${SHORT}`));

  test("the anchor wins over HEAD", () => {
    expect(ask().withCtx).toBe(`session-base/${SHORT}`);
  });

  // The window closes: this is the whole point of preferring the anchor.
  test("and a mid-session checkout no longer moves the base", () => {
    g("checkout", "-q", "-b", "feature/x");
    writeFileSync(join(REPO, "f.txt"), "elsewhere\n");
    g("add", "-A");
    g("commit", "-qm", "unrelated work");
    expect(ask().withCtx).toBe(`session-base/${SHORT}`);
  });

  // A caller that needs the base branch NAME (setup-worktree creating the session
  // branch, the merger promoting into it) passes no ctx and still gets HEAD: a
  // promotion merges into a branch, and the anchor is a commit.
  test("a ctx-less caller still gets the branch name", () => {
    expect(ask().withoutCtx).toBe("main");
  });
});
