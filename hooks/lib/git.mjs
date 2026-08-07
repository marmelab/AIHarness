// Git repo and worktree state queries.

import { REPO } from "./paths.mjs";
import { exec } from "./process.mjs";
import { sessionBaseBranch } from "./topology.mjs";

export function git(args = [], opts = {}) {
  return exec("git", ["-C", REPO, ...args], opts);
}

/**
 * The ref a hook diffs against.
 *
 * With a ctx, the session's FORK ANCHOR wins: `session-base/<short>` is a fixed commit
 * created alongside the session branch, so "what has this session changed" keeps
 * meaning the same thing for the whole session. The repo's HEAD does not: it is
 * whatever the human has checked out right now.
 *
 * EXPOSURE WINDOW, and it is real. Before the anchor exists there is nothing to anchor
 * to and the answer is the current HEAD. That window is open from the start of a
 * session until its first developer dispatch, because setup-worktree creates the
 * session branch, the anchor and the recorded base-branch name together, from HEAD. A
 * human who switches branches inside that window silently moves the base: the session
 * forks from, validates against, and later promotes into whatever happened to be
 * checked out at that moment. Nothing detects it, because a different HEAD is
 * indistinguishable from an intentional one. The window closes at the first dispatch
 * and never reopens: once recorded, neither the anchor nor the name is rewritten.
 *
 * Callers that need the base branch NAME rather than a diff base (setup-worktree
 * creating the session branch, the merger promoting into it) must NOT pass a ctx: a
 * name is what a promotion merges into, and the anchor is a commit. session-state's
 * forkBaseBranch answers that question, from `sessionbase.<short>.branch`.
 *
 * @param {{sessionShort?: string}} [ctx]
 * @returns {string}
 */
export function getBaseBranch(ctx) {
  if (ctx?.sessionShort) {
    const anchor = sessionBaseBranch(ctx);
    if (git(["rev-parse", "--verify", "--quiet", anchor]).status === 0) {
      return anchor;
    }
  }
  const r = git(["symbolic-ref", "--short", "HEAD"]);
  return (r.status === 0 ? r.stdout.trim() : "") || "main";
}

const WORKTREE_PREFIX = "worktree ";
const BRANCH_PREFIX = "branch refs/heads/";

// Value of the first line carrying `prefix`, stripped of it; "" when absent.
const lineValue = (lines, prefix) => {
  const line = lines.find((l) => l.startsWith(prefix));
  return line ? line.slice(prefix.length) : "";
};

// `--porcelain` emits one blank-line-separated block per worktree, each opening
// with a `worktree <path>` line and (unless detached/bare) a `branch refs/...`
// line. Parse each block independently; drop blocks with no path (trailing blank).
export function getWorktreeEntries() {
  return git(["worktree", "list", "--porcelain"])
    .stdout.split("\n\n")
    .map((block) => block.split("\n"))
    .map((lines) => ({
      path: lineValue(lines, WORKTREE_PREFIX),
      branch: lineValue(lines, BRANCH_PREFIX),
    }))
    .filter((entry) => entry.path);
}

export const getWorktreePaths = () => getWorktreeEntries().map((e) => e.path);

// Combined per-worktree change summary in a single `git status --porcelain`
// (working tree) + one `git log` (commits ahead of base) + one `git diff
// --name-only` (committed file names). Returns { dirty, changedFiles } so callers
// (validate-on-stop) get both signals without spawning `git status` twice.
export function getWorktreeChangeSummary(wt, base) {
  const nonEmpty = (lines) => lines.split("\n").filter((l) => l.trim());
  const statusPath = (line) => line.trim().split(/\s+/).pop();
  const working = exec("git", ["-C", wt, "status", "--porcelain"]).stdout;
  const ahead = exec("git", [
    "-C",
    wt,
    "log",
    "--oneline",
    `${base}..HEAD`,
  ]).stdout.trim();
  const committed = exec("git", [
    "-C",
    wt,
    "diff",
    "--name-only",
    `${base}..HEAD`,
  ]).stdout;
  const changedFiles = [
    ...new Set([
      ...nonEmpty(committed).map((l) => l.trim()),
      ...nonEmpty(working).map(statusPath),
    ]),
  ];
  return { dirty: Boolean(working.trim() || ahead), changedFiles };
}

// Task branches under refs/heads/<short>/ that still have commits NOT merged into
// `sessionRef`. The single source of truth for the promotion-safety check
// (block-promote-unmerged.mjs); the orchestrator's STATE B reconcile Bash
// mirrors it and must stay aligned. Fails CLOSED: a failed/unparseable rev-list
// count is reported as unmerged (count: null) rather than silently treated as
// merged. `exclude` simple branches that legitimately never merge into the session
// branch (e.g. <short>/simple, which promotes straight to main).
export function getUnmergedTaskBranches(short, sessionRef, exclude = []) {
  const branches = git([
    "for-each-ref",
    "--format=%(refname:short)",
    `refs/heads/${short}`,
  ])
    .stdout.split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((b) => !exclude.includes(b));

  const unmerged = [];
  for (const br of branches) {
    const r = git(["rev-list", "--count", `${sessionRef}..${br}`]);
    const n = Number(r.stdout.trim());
    if (r.status !== 0 || !Number.isFinite(n)) {
      unmerged.push({ branch: br, count: null }); // fail closed
    } else if (n > 0) {
      unmerged.push({ branch: br, count: n });
    }
  }
  return unmerged;
}
