#!/usr/bin/env node
// SubagentStop — remove this session's task worktrees once their branch has been
// merged (--no-ff, the merger's contract) into the session integration branch and
// the worktree has no uncommitted changes. Session worktrees/branches (_session,
// simple, session*/), fresh worktrees, and unmerged work are preserved.

import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { basename, join } from "node:path";
import { createHookContext } from "./lib/context.mjs";
import { readAgentMeta } from "./lib/agent-meta.mjs";
import { isMerger } from "./lib/teams.mjs";
import {
  getBaseBranch,
  getWorktreeEntries,
  getWorktreePaths,
  git,
} from "./lib/git.mjs";
import { exec } from "./lib/process.mjs";
import {
  isInfraWorktreePath,
  isProtectedBranch,
  isTaskWorktreeDirName,
  sessionBaseBranch,
  sessionBranch,
} from "./lib/topology.mjs";
import { removeWorktree } from "./lib/worktree.mjs";
import { removeWorktreeFolders } from "./lib/workspace-folders.mjs";
import { sessionDirFromEnv } from "./lib/config.mjs";

const raw = readFileSync(0, "utf8");
const ctx = createHookContext(raw, "cleanup-worktree");

// SubagentStop fires this on EVERY subagent stop here (the matcher doesn't filter
// and agent_type is empty in the payload). cleanup is the MERGER's post-merge step,
// so skip the worktree sweep when the resolved agent meta shows the stopping agent is
// clearly NOT a merger (developer / reviewer / planner / ...). The sweep is
// idempotent either way; this just avoids running it on every stop. Meta
// missing/ambiguous: proceed with the normal cleanup.
//
// The comparison goes through isMerger (i.e. bareRole), never `=== "merger"`. A
// plugin-provided agent arrives NAMESPACED, so the raw compare never matched
// `aiharness:merger` and this skip fired on the merger's own stop as readily as on
// anyone else's. It was harmless only because the sweep is idempotent and something
// else eventually ran it.
{
  let payload = {};
  try {
    payload = JSON.parse(raw);
  } catch {
    /* proceed */
  }
  // Silent: this fires on every stop of every role, so a line here is a line per
  // subagent stop for the whole session saying that nothing was asked of this hook.
  // The merger stop that DOES sweep logs its summary at the end.
  const meta = readAgentMeta(payload);
  if (meta && meta.agentType && !isMerger(meta.agentType)) process.exit(0);
}

// Nothing has been created yet: also not an event.
if (!existsSync(ctx.worktreeBase)) process.exit(0);

const base = getBaseBranch();

const isUnderBase = (p) =>
  p === ctx.worktreeBase || p.startsWith(ctx.worktreeBase + "/");

const hasLocalBranch = (ref) =>
  git(["show-ref", "--verify", "--quiet", `refs/heads/${ref}`]).status === 0;

// Tips that were merged with --no-ff into the session integration branch: the
// second-plus parents of its merge commits. Ancestry alone cannot tell a merged
// branch from a fresh one that never diverged (both tips are ancestors), and a
// fresh worktree may belong to a developer still working — so only branches
// whose tip is a recorded merge parent are removable.
const getMergedTips = () => {
  const integration = sessionBranch(ctx);
  if (!hasLocalBranch(integration)) return new Set();
  const anchor = sessionBaseBranch(ctx);
  const range = hasLocalBranch(anchor)
    ? `${anchor}..${integration}`
    : integration;
  return new Set(
    git(["log", "--merges", "--format=%P", range])
      .stdout.split("\n")
      .filter(Boolean)
      .flatMap((line) => line.split(" ").slice(1)),
  );
};
const mergedTips = getMergedTips();

// A skip is the NORMAL outcome: this hook fires on every subagent stop and sweeps
// every worktree each time, so a line per skipped worktree is a line per worktree per
// stop, and it drowns the removals. The reason a worktree was kept is still recorded,
// but once, in the summary at the end. What gets its own line is what CHANGED.
const skipReason = ({ path: wtPath, branch }) => {
  if (isInfraWorktreePath(wtPath)) return "session-worktree";
  if (!branch) return "detached";
  const tip = git(["rev-parse", "--verify", branch]).stdout.trim();
  if (!tip || !mergedTips.has(tip)) return "unmerged";
  if (exec("git", ["-C", wtPath, "status", "--porcelain"]).stdout.trim()) {
    return "dirty";
  }
  return "";
};

const deleteBranch = (branch) => {
  if (!branch) return;
  // A protected branch reaching here would be a bug in shouldRemove above, not
  // routine, so it stays a log line.
  if (isProtectedBranch(branch)) {
    ctx.log(`SKIP-SESSION-BRANCH ${branch}`);
    return;
  }
  if (git(["branch", "-d", branch]).status !== 0) {
    git(["branch", "-D", branch]);
  }
  ctx.log(`BRANCH-DELETED ${branch}`);
};

const ourWorktrees = getWorktreeEntries().filter((e) => isUnderBase(e.path));
const skipped = [];
const toRemove = ourWorktrees.filter((e) => {
  const reason = skipReason(e);
  if (reason) skipped.push(`${basename(e.path)}:${reason}`);
  return !reason;
});

toRemove.forEach((e) => {
  removeWorktree(e.path);
  ctx.log(`REMOVED ${e.path}`);
});
toRemove.map((e) => e.branch).forEach(deleteBranch);

// Drop the merged worktrees from the editor's workspace folders (setup-worktree
// added them on a technical run). No-op under a managed launcher or a mono-folder
// window (no `.code-workspace` to edit; `code --remove` does not exist).
if (!sessionDirFromEnv() && toRemove.length) {
  const removed = new Set(toRemove.map((e) => e.path));
  removeWorktreeFolders(ctx.repo, (p) => removed.has(p));
}

git(["worktree", "prune"]);

const registered = getWorktreePaths();

// The session dir holds the harness's own state (breaker/, reviews/, locks/, tickets/)
// alongside the worktrees, so most entries here are not worktrees and never will be.
// Logging each one as "non-worktree" on every stop said nothing and said it loudly.
const sweepLeftover = (entry) => {
  if (!entry.isDirectory()) return;
  const dir = join(ctx.worktreeBase, entry.name);
  if (dir.endsWith("/_session")) return;
  if (!isTaskWorktreeDirName(entry.name)) return;
  if (registered.includes(dir)) return;
  rmSync(dir, { recursive: true, force: true });
  ctx.log(`LEFTOVER RM ${dir}`);
};

readdirSync(ctx.worktreeBase, { withFileTypes: true }).forEach(sweepLeftover);

try {
  rmdirSync(ctx.worktreeBase);
} catch {
  // not empty / already gone — fine
}

// One line per sweep, and it is the only one when nothing changed: what was removed,
// and what was kept and why. Everything above logs an ACTION.
ctx.accept(
  `removed=${toRemove.length} kept=${skipped.length}${skipped.length ? ` [${skipped.join(" ")}]` : ""} session=${ctx.sessionShort} base=${base}`,
);
