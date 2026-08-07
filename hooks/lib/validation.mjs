import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import {
  getBaseBranch,
  getWorktreeChangeSummary,
  getWorktreePaths,
} from "./git.mjs";
import { bash, exec } from "./process.mjs";
import { loadConfig, validationSteps } from "./config.mjs";
import { acquireLock } from "./lock.mjs";
import { appendProgress } from "./progress-log.mjs";
import { clearValidationGaveUp, validationGaveUpFlag } from "./reviews.mjs";
import { sessionWorktreePath } from "./topology.mjs";

// `only` narrows to the worktree the caller has already attributed to the stopping agent;
// VALIDATE_WORKTREE is the test override.
//
// A narrowed path that no longer exists returns NOTHING, never every session worktree: a
// stop nobody can attribute must not sweep its siblings' trees, re-running work nobody
// asked for and running the formatter's auto-commit over developers who are mid-edit.
//
// The un-narrowed listing excludes the _session worktree. That one belongs to the merger:
// it holds integrated work whose own tickets were each validated on their own branch, and
// nobody stops "as" _session, so validating it only duplicates work already done.
export function getActiveWorktrees(ctx, only = "") {
  const narrowed = only || process.env.VALIDATE_WORKTREE || "";
  if (narrowed) return existsSync(narrowed) ? [narrowed] : [];
  const session = sessionWorktreePath(ctx);
  return getWorktreePaths().filter(
    (p) => p.startsWith(ctx.worktreeBase + "/") && p !== session,
  );
}

// Pure query — never exits. An empty list with a non-empty skipReason means
// there is nothing to validate.
function getWorktreesToValidate(
  ctx,
  { skipAdrOnly = false, only = "", base = "" } = {},
) {
  if (!existsSync(ctx.repo)) {
    return { worktrees: [], skipReason: "cd_failed" };
  }
  const active = getActiveWorktrees(ctx, only);
  if (active.length === 0) {
    return { worktrees: [], skipReason: "no_active_worktree" };
  }
  // Compare against the branch the worktree forked from (the session branch,
  // passed by validate-on-stop) so the change set is the ticket's OWN work, not
  // everything since the repo's checked-out base branch — which would over- or
  // under-report a worktree's delta whenever the base branch has diverged from
  // the session branch. Falls back to the repo base branch when no override.
  const effectiveBase = base || getBaseBranch(ctx);
  const isAdrOnly = (files) =>
    files.length > 0 && files.every((f) => f.startsWith("adr/"));
  const worktrees = active.filter((wt) => {
    const { dirty, changedFiles } = getWorktreeChangeSummary(wt, effectiveBase);
    if (!dirty) {
      ctx.log(`SKIP wt=${wt} (no changes)`);
      return false;
    }
    if (skipAdrOnly && isAdrOnly(changedFiles)) {
      ctx.log(`SKIP wt=${wt} (adr-only)`);
      return false;
    }
    return true;
  });
  return {
    worktrees,
    skipReason: worktrees.length === 0 ? "no_dirty_worktree" : "",
  };
}

const tailLines = (text, n) => text.split("\n").slice(-n).join("\n");

// Last `n` lines of a file, "" if it can't be read.
const tailFile = (path, n) => {
  try {
    return tailLines(readFileSync(path, "utf8"), n);
  } catch {
    return "";
  }
};

// Best-effort cleanup — a leftover temp file must never break validation.
const tryUnlink = (path) => {
  try {
    unlinkSync(path);
  } catch {
    /* swallow error */
  }
};

function runVitest(wt, configFile, projects = [], changedSince = "") {
  const projectTag = projects.length ? `-${projects.join("-")}` : "";
  const out = join(
    tmpdir(),
    `vitest-${basename(configFile)}${projectTag}-${process.pid}.out`,
  );
  const projectFlags = projects.map((p) => `--project ${p}`).join(" ");
  // Scope to tests related to THIS worktree's diff since `changedSince` (the session
  // branch it forked from), so a ticket runs only its own affected tests, not the whole
  // suite. Pass the ref EXPLICITLY: the ticket's work is committed by stop time,
  // so a bare `--changed` (uncommitted-only) would find nothing and run zero tests (false
  // green). Empty ref -> full run (safe fallback). The end-of-feature smoke re-runs the
  // full suite on the integrated session branch, catching anything the module graph missed.
  const changedFlag = changedSince ? `--changed ${changedSince}` : "";
  const r = bash(
    `CI=true timeout 180 npx vitest run --config ${configFile} ${projectFlags} ${changedFlag} > "${out}" 2>&1`,
    { cwd: wt },
  );
  const output = tailFile(out, 40);
  tryUnlink(out);
  return { status: r.status, output, timedOut: r.status === 124 };
}

// Files this worktree changed that lint should check: the config `extensions`,
// restricted to paths that still exist on disk. A deleted / renamed-away file
// must not be handed to eslint (it would error "No files matching"). Pure —
// unit-tested independently of the shell-out.
export function scopedLintFiles(changedFiles, cwd, extensions) {
  return changedFiles.filter(
    (f) => extensions.some((e) => f.endsWith(e)) && existsSync(join(cwd, f)),
  );
}

// Run eslint on ONLY this worktree's diff since `base` (the session branch it
// forked from), mirroring the vitest `--changed` scoping: a ticket is judged on
// its own changed files, never the whole repo — which also sidesteps pre-existing
// lint noise in unrelated / generated files. Zero matching files -> nothing to
// lint (ok). `base` empty -> repo base branch, matching getWorktreesToValidate.
// `command` is the eslint invocation prefix (e.g. `npx eslint`); files are
// appended here, so the config command must NOT carry its own file glob.
function runEslintScoped(ctx, cwd, base, command, extensions, tail) {
  const { changedFiles } = getWorktreeChangeSummary(
    cwd,
    base || getBaseBranch(ctx),
  );
  const files = scopedLintFiles(changedFiles, cwd, extensions);
  if (files.length === 0) return { ok: true };
  const out = join(tmpdir(), `eslint-${process.pid}.out`);
  const args = files.map((f) => `'${f.replace(/'/g, `'\\''`)}'`).join(" ");
  const r = bash(`${command} ${args} > "${out}" 2>&1`, { cwd });
  const output = tailFile(out, tail);
  tryUnlink(out);
  return r.status === 0 ? { ok: true } : { ok: false, output };
}

// Per-kind tail length for failure output (mechanical, not a project fact).
const TAIL_LINES = { format: 15, typecheck: 20, lint: 30, unit: 40, e2e: 50 };

// A step is skipped when its `condition` is not met. `pathExists` gates on a
// path under the repo (e.g. the supabase/functions unit-fn gate); `modeNot`
// skips when MODE equals the given value (no step uses it today, and MODE is set
// only by a managed launcher, never by this repo's settings.json).
function stepSkipped(ctx, step) {
  const c = step.condition;
  if (!c) return false;
  if (c.pathExists && !existsSync(join(ctx.repo, c.pathExists))) {
    ctx.log(`SKIP ${step.id} (no ${c.pathExists})`);
    return true;
  }
  if (c.modeNot && (process.env.MODE || "demo") === c.modeNot) {
    ctx.log(`${step.id} skipped (${c.modeNot} mode)`);
    return true;
  }
  return false;
}

// Release the stop but keep the work out of the base branch: the marker is read by
// block-merger-without-review, which refuses the merger dispatch for this ticket.
function giveUp(ctx, cwd, stepId, attempts, output) {
  const taskId = basename(cwd);
  try {
    const flag = validationGaveUpFlag(ctx, taskId);
    mkdirSync(dirname(flag), { recursive: true });
    writeFileSync(
      flag,
      JSON.stringify(
        {
          kind: "validation-gave-up",
          taskId,
          step: stepId,
          attempts,
          finishedAt: new Date().toISOString(),
          output: String(output || "")
            .split("\n")
            .slice(-30)
            .join("\n"),
        },
        null,
        2,
      ),
    );
  } catch {
    /* best effort: the log line above still records it */
  }
}

// Sugar: the label a successful step clears its counter under.
const id0 = (step, r) => r.step ?? step.id;

// A green stop is the contract, so refusing a red one is right in principle. With no budget
// it wedges: a developer thrashing on one failing step is refused forever, with no signal to
// the orchestrator and no way to give up (validate-on-stop does not read the FAILED contract
// line).
//
// So: count consecutive failures per worktree AND per step, because a developer that fixes
// lint and then breaks a test should not inherit the lint budget. Past the limit, release the
// stop and drop a marker; block-merger-without-review then refuses to merge that ticket, so
// "we never merge red" survives mechanically without the wedge.
const STEP_FAIL_LIMIT = 5;
const stepFailFile = (ctx, cwd, stepId) => {
  const dir = join(ctx.sessionDir, "breaker");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return join(dir, `step-fail-${basename(cwd)}-${stepId}`);
};
const readStepFails = (ctx, cwd, stepId) => {
  try {
    return (
      parseInt(readFileSync(stepFailFile(ctx, cwd, stepId), "utf8"), 10) || 0
    );
  } catch {
    return 0;
  }
};
const writeStepFails = (ctx, cwd, stepId, n) => {
  try {
    writeFileSync(stepFailFile(ctx, cwd, stepId), String(n));
  } catch {
    /* best effort */
  }
};
const clearStepFails = (ctx, cwd, stepId) => {
  try {
    unlinkSync(stepFailFile(ctx, cwd, stepId));
  } catch {
    /* absent - fine */
  }
};

// --- green cache --------------------------------------------------------------------
// A worktree whose HEAD and working-tree state are byte-for-byte what a green chain
// already validated has nothing new to check, so the chain is skipped. Without it a
// developer that stops several times without changing anything pays for the full chain
// every time.
//
// The key is HEAD plus a hash of `git status --porcelain`, so it covers both "committed
// nothing new" and "edited nothing new": either one changing is a cache miss. Only ever
// written after a FULLY green chain, so a cached hit can never stand in for a step that
// failed or gave up. Advisory, like every other marker under breaker/: an unreadable or
// unwritable cache just means the chain runs.
const greenCacheFile = (ctx, cwd) => {
  const dir = join(ctx.sessionDir, "breaker");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return join(dir, `validated-${basename(cwd)}`);
};

// Where the per-worktree chain locks live. Under the session dir, so a lock is never a
// file inside the tree being validated. Created eagerly because acquireLock's mkdir needs
// its parent to exist.
const lockRoot = (ctx) => {
  const dir = join(ctx.sessionDir, "locks");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort: acquireLock then fails to create and the chain runs unlocked */
  }
  return dir;
};

const worktreeState = (cwd) => {
  const head = exec("git", ["-C", cwd, "rev-parse", "HEAD"]).stdout.trim();
  const porcelain = exec("git", ["-C", cwd, "status", "--porcelain"]).stdout;
  if (!head) return ""; // no HEAD yet: never cacheable
  return `${head} ${createHash("sha1").update(porcelain).digest("hex")}`;
};

const isCachedGreen = (ctx, cwd, state) => {
  if (!state || process.env.VALIDATE_NO_CACHE === "1") return false;
  try {
    return readFileSync(greenCacheFile(ctx, cwd), "utf8").trim() === state;
  } catch {
    return false;
  }
};

// Recomputed, not passed in: the format step's auto-commit moves HEAD, so the state to
// remember is the one the chain LEFT behind, not the one it started from.
const recordGreen = (ctx, cwd) => {
  const state = worktreeState(cwd);
  if (!state) return;
  try {
    writeFileSync(greenCacheFile(ctx, cwd), `${state}\n`);
  } catch {
    /* best effort */
  }
};

// Per-worktree budget for "you stopped without committing" rejections. Scoped per worktree
// because sibling developers stop independently, and under the session's breaker/ dir like
// the other bounded rejections.
const DIRTY_REJECT_LIMIT = 2;
const dirtyRejectFile = (ctx, cwd) => {
  const dir = join(ctx.sessionDir, "breaker");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort */
  }
  return join(dir, `format-dirty-${basename(cwd)}`);
};
const readDirtyRejects = (ctx, cwd) => {
  try {
    return parseInt(readFileSync(dirtyRejectFile(ctx, cwd), "utf8"), 10) || 0;
  } catch {
    return 0;
  }
};
const writeDirtyRejects = (ctx, cwd, n) => {
  try {
    writeFileSync(dirtyRejectFile(ctx, cwd), String(n));
  } catch {
    /* best effort */
  }
};
const clearDirtyRejects = (ctx, cwd) => {
  try {
    unlinkSync(dirtyRejectFile(ctx, cwd));
  } catch {
    /* absent - fine */
  }
};

// Untracked paths in `cwd`, split into the ones a commit may take and the ones it must
// not. A binary file is anything with a NUL byte in its first 8k, which is how git itself
// decides. Source belongs in a commit; a test run's image artifacts (Playwright / vitest
// failure screenshots) never do. Committing them bloats the ticket branch and turns any
// later rebase into a conflict nobody can resolve by reading.
function splitUntracked(cwd) {
  const out = exec("git", [
    "-C",
    cwd,
    "ls-files",
    "--others",
    "--exclude-standard",
  ]).stdout;
  const text = [];
  const binary = [];
  for (const rel of out.split("\n").filter(Boolean)) {
    const abs = join(cwd, rel);
    let isBinary = false;
    try {
      if (statSync(abs).isDirectory()) continue;
      const buf = readFileSync(abs);
      isBinary = buf.subarray(0, 8000).includes(0);
    } catch {
      isBinary = true; // unreadable: do not commit it
    }
    (isBinary ? binary : text).push(rel);
  }
  return { text, binary };
}

// Stage what a validation-owned commit is allowed to contain: modifications and deletions
// of TRACKED files, plus untracked TEXT files when `withUntracked`. Never `git add -A`.
// The formatter only ever rewrites files that are already tracked, so the post-format
// commit passes withUntracked=false and cannot sweep anything else in.
function stageForCommit(cwd, { withUntracked }) {
  exec("git", ["-C", cwd, "add", "-u"]);
  if (!withUntracked) return { binary: [] };
  const { text, binary } = splitUntracked(cwd);
  if (text.length) exec("git", ["-C", cwd, "add", "--", ...text]);
  return { binary };
}

// Run ONE config-declared step in `cwd`. Returns { ok } or { ok:false, output }.
// The step id is the caller's fail-report label, so config ids (prettier,
// typecheck, unit-app, unit-fn, e2e) ARE the reported step names.
//
// `owner` is the worktree the STOPPING agent owns. Anything that mutates a repository
// (the dirty-work budget, the fallback commit, the formatter's commit) is gated on
// cwd === owner, so this chain can never write into a worktree whose own agent is still
// working. validate-on-stop already narrows to one worktree, which makes that unreachable
// in practice; the gate makes it structural, so a caller that passes a wider set cannot
// reintroduce it.
function runStep(ctx, step, { cwd, base, owner = "" }) {
  const owns = owner !== "" && cwd === owner;
  const tail = TAIL_LINES[step.kind] ?? 40;

  if (step.runner === "vitest") {
    const r = runVitest(
      cwd,
      step.config,
      step.projects,
      step.changedScoped ? base : "",
    );
    if (r.timedOut)
      return {
        ok: false,
        output: "TIMEOUT (>180s) -- vitest did not exit. Tests may be hanging.",
      };
    return r.status === 0 ? { ok: true } : { ok: false, output: r.output };
  }

  if (step.kind === "lint" && step.changedScoped) {
    const exts = step.extensions ?? [".ts", ".tsx", ".mjs"];
    return runEslintScoped(ctx, cwd, base, step.command, exts, tail);
  }

  // A dirty tree BEFORE the formatter runs means the agent stopped without committing. It
  // must not be swept into the formatter's commit: the agent's real work would land under
  // a `style(...)` subject with no developer commit at all, and the history would then lie
  // to review, to /harness-diff and to the revert path.
  //
  // Rejecting the stop is the enforcement, BOUNDED. Nothing in the harness forbids an
  // agent from committing (verified against every Bash guard), but a commit can still fail
  // for reasons outside the agent's control, a failing pre-commit hook being the obvious
  // one. An unbounded "commit or I refuse" would then wedge the pipeline forever, which is
  // the same shape as the foreground gate that had to be relaxed. So: reject twice, then
  // commit the work with an HONEST message and let the stop through. The contract is
  // enforced in the normal case and the history never lies in either case.
  //
  // Both halves are OWNER-ONLY. A dirty tree that is not ours is somebody else still
  // working: not a contract breach, nothing to reject, and certainly nothing to commit.
  if (step.kind === "format" && step.autoCommit) {
    const dirty =
      exec("git", ["-C", cwd, "status", "--porcelain"]).stdout.trim() !== "";
    if (dirty && !owns) {
      ctx.log(
        `dirty but not ours, left alone wt=${cwd} owner=${owner || "none"}`,
      );
    } else if (!dirty) {
      clearDirtyRejects(ctx, cwd);
    } else {
      const rejects = readDirtyRejects(ctx, cwd);
      if (rejects < DIRTY_REJECT_LIMIT) {
        writeDirtyRejects(ctx, cwd, rejects + 1);
        return {
          ok: false,
          // Not a prettier failure: prettier has not run yet. Reporting `prettier` here
          // told the agent the formatter broke, which sent it looking in the wrong place.
          step: "uncommitted",
          output:
            "Uncommitted changes in the worktree. Commit your work before stopping: the " +
            "output contract requires a commit sha, and the formatting step must not " +
            "commit your changes for you under a `style(...)` message. " +
            `(attempt ${rejects + 1}/${DIRTY_REJECT_LIMIT})\n` +
            tailLines(exec("git", ["-C", cwd, "status", "--short"]).stdout, 20),
        };
      }
      // Still uncommitted after the budget: never wedge. Commit it, but say whose work it
      // is and what was deliberately left out of it.
      const task = basename(cwd);
      const { binary } = stageForCommit(cwd, { withUntracked: true });
      exec("git", [
        "-C",
        cwd,
        "commit",
        "-m",
        `chore(${task}): commit work the ${task} agent left uncommitted`,
      ]);
      clearDirtyRejects(ctx, cwd);
      ctx.log(
        `uncommitted work persisted after ${rejects} rejection(s), committed wt=${cwd}` +
          (binary.length
            ? ` (left untracked binary artifacts: ${binary.slice(0, 5).join(", ")})`
            : ""),
      );
    }
  }

  const r = bash(`${step.command} 2>&1`, { cwd });
  if (r.status === 0) {
    if (step.kind === "format" && step.autoCommit && owns) {
      // Reached with a clean tree (or one the fallback above just committed), so a
      // TRACKED file that differs now was rewritten by the formatter. Stage exactly
      // those: `git add -A` here is what let untracked artifacts ride along under a
      // `style(...)` subject, including the ones the fallback deliberately left behind.
      if (exec("git", ["-C", cwd, "diff", "--quiet"]).status !== 0) {
        stageForCommit(cwd, { withUntracked: false });
        exec("git", [
          "-C",
          cwd,
          "commit",
          "-m",
          `style(${basename(cwd)}): auto-apply prettier`,
        ]);
        ctx.log(`auto-prettier committed wt=${cwd}`);
      }
    }
    return { ok: true };
  }
  const detail =
    step.kind === "format"
      ? "Prettier could not format one or more files (likely a syntax error). Fix the issue and commit.\n" +
        tailLines(r.stdout, tail)
      : tailLines(r.stdout, tail);
  return { ok: false, output: detail };
}

// The full validation chain, run by validate-on-stop.mjs on SubagentStop (after
// every developer stop). Steps are declared in harness.config.json's
// `validation.steps` (single source of truth, shared with bash-guard) and run in
// config order: steps without `cwd:"repo"` run per dirty worktree (fail-fast);
// `cwd:"repo"` steps run once in the repo after the per-worktree pass (none today:
// e2e is end-of-feature only, run by the orchestrator on the session worktree).
// VALIDATE_DRY_RUN=1 skips everything, =fail simulates a failure. A malformed
// config fails closed. Returns { ok:true, skipReason? } or { ok:false, step, output }.
export function runValidationSteps(
  ctx,
  { worktree = "", base = "", owner = "" } = {},
) {
  if (process.env.VALIDATE_DRY_RUN === "1") {
    ctx.log("DRY_RUN=1, skipping validation");
    return { ok: true, skipReason: "dry_run" };
  }
  if (process.env.VALIDATE_DRY_RUN === "fail") {
    ctx.log("DRY_RUN=fail, simulating a failure");
    return {
      ok: false,
      step: "dry-run",
      output: "Validation failed (simulated).",
    };
  }

  let steps;
  try {
    steps = validationSteps(loadConfig(ctx.repo));
  } catch (e) {
    // Fail closed: a malformed config must block the stop, not silently pass.
    return { ok: false, step: "config", output: `${e.message}\n` };
  }

  const { worktrees, skipReason } = getWorktreesToValidate(ctx, {
    skipAdrOnly: true,
    only: worktree,
    base,
  });
  if (skipReason) return { ok: true, skipReason };

  const perWorktree = steps.filter((s) => s.cwd !== "repo");
  const repoLevel = steps.filter((s) => s.cwd === "repo");

  // Enrich the #technical-harness progress log with each validation step as it runs,
  // so the otherwise-silent multi-minute chain (typecheck, lint, vitest, e2e) shows up
  // in a `tail -f` / the board / a Monitor. Inert (no-op) on a non-technical run: the
  // log does not exist there, so appendProgress writes nothing and creates nothing.
  const progress = (line) => appendProgress(ctx.sessionDir, line);

  for (const wt of worktrees) {
    // Nothing has changed since a green chain: skip. See greenCacheFile.
    const stateBefore = worktreeState(wt);
    if (isCachedGreen(ctx, wt, stateBefore)) {
      ctx.log(`SKIP wt=${wt} (unchanged since last green: ${stateBefore})`);
      continue;
    }

    // One chain per worktree at a time: two chains overlapping here race on the git index
    // through the formatter's auto-commit step. A concurrent chain would only validate the
    // same state twice, so the loser SKIPS rather than waits (timeoutMs 0, the acquireLock
    // default). Advisory: if the lock cannot be created at all the chain runs anyway,
    // because a lock that can wedge validation is worse than the race.
    //
    // The lock lives in the SESSION dir, never inside the worktree: an untracked lock
    // directory there would show up in `git status --porcelain`, which is both the
    // dirty-work check's input and the green cache's key.
    const lock = acquireLock(
      join(lockRoot(ctx), `validate-${basename(wt)}.lock`),
    );
    if (!lock.locked && lock.held) {
      ctx.log(`SKIP wt=${wt} (another validation chain holds the lock)`);
      continue;
    }
    let outcome;
    try {
      outcome = runWorktreeChain(ctx, wt, perWorktree, {
        base,
        owner,
        progress,
      });
    } finally {
      lock.release();
    }
    if (!outcome.ok) return outcome;
  }

  for (const step of repoLevel) {
    if (stepSkipped(ctx, step)) continue;
    progress(`[validate:repo] ${step.id}…`);
    const r = runStep(ctx, step, { cwd: ctx.repo, base });
    if (!r.ok) {
      progress(`[validate:repo] ${step.id} FAILED`);
      // STEP-FAIL, not FAIL: the caller that owns the stop logs the one FAIL verdict,
      // and two lines saying the same thing under the same verb is what made a failure
      // read as two.
      ctx.log(`STEP-FAIL step=${step.id} wt=repo`);
      return { ok: false, step: step.id, output: r.output + "\n" };
    }
    ctx.log(`${step.id} OK`);
  }

  return { ok: true };
}

// One worktree's chain, fail-fast. Extracted so the caller can hold the per-worktree lock
// across it with a single try/finally: the failure paths below return from the middle of
// the chain, and inlining this in the loop meant either leaking the lock or wrapping every
// return.
function runWorktreeChain(ctx, wt, perWorktree, { base, owner, progress }) {
  const label = basename(wt);
  // A step that gave up releases the stop and continues, so the loop still reaches its end.
  // Without this flag the "green" path below would then clear the marker just written.
  let gaveUpHere = false;
  for (const step of perWorktree) {
    if (stepSkipped(ctx, step)) continue;
    progress(`[validate:${label}] ${step.id}…`);
    const r = runStep(ctx, step, { cwd: wt, base, owner });
    if (!r.ok) {
      // A step may report its own label when the failure is not its command failing
      // (the uncommitted-work check runs before the formatter, so calling it
      // "prettier" would point the agent at the wrong thing).
      const id = r.step ?? step.id;

      // A step that reports its OWN label also owns its OWN budget and its own recovery
      // (the uncommitted-work check rejects twice, then commits honestly). Counting it here
      // as well gave one condition two counters with different limits, and a message that
      // said `attempt 2/2` in its body while the log said `attempt=2/5`. Contradictory
      // advice is worse than none. So the generic budget covers only the steps with no
      // budget of their own: a failing command, where the agent must reach green or be
      // stopped.
      if (r.step) {
        progress(`[validate:${label}] ${id} FAILED`);
        ctx.log(`STEP-FAIL step=${id} wt=${wt}`);
        return {
          ok: false,
          step: id,
          output: `=== ${id} failed in ${wt} ===\n${r.output}\n`,
        };
      }

      const fails = readStepFails(ctx, wt, id) + 1;
      writeStepFails(ctx, wt, id, fails);
      progress(
        `[validate:${label}] ${id} FAILED (${fails}/${STEP_FAIL_LIMIT})`,
      );
      ctx.log(
        `STEP-FAIL step=${id} wt=${wt} attempt=${fails}/${STEP_FAIL_LIMIT}`,
      );

      if (fails >= STEP_FAIL_LIMIT) {
        // Give up rather than wedge, and record WHY so the merge is refused later.
        giveUp(ctx, wt, id, fails, r.output);
        progress(
          `[validate:${label}] ${id} gave up after ${fails}, merge will be refused`,
        );
        ctx.log(
          `GAVE-UP step=${id} wt=${wt} after=${fails}; merge blocked for this ticket`,
        );
        clearStepFails(ctx, wt, id);
        gaveUpHere = true;
        continue;
      }

      return {
        ok: false,
        step: id,
        output:
          `=== ${id} failed in ${wt} (attempt ${fails}/${STEP_FAIL_LIMIT}) ===\n${r.output}\n` +
          (fails === STEP_FAIL_LIMIT - 1
            ? "This is your LAST attempt at this step. On the next failure the stop is " +
              "released, the ticket is marked as failing validation, and the merger will " +
              "refuse to merge it. If you cannot get to green, say so in your final " +
              "message rather than repeating the same fix.\n"
            : ""),
      };
    }
    clearStepFails(ctx, wt, id0(step, r));
  }
  // Green: the ticket is mergeable again. Without this the give-up marker outlives the fix
  // and block-merger-without-review keeps refusing a ticket whose validation now passes.
  if (!gaveUpHere) clearValidationGaveUp(ctx, basename(wt));
  // Remember the state this chain left behind, so an unchanged worktree is not
  // re-validated on the next stop. Two conditions, both load-bearing:
  //   - a FULLY green pass. A chain that gave up above took the `continue` and reaches
  //     here with gaveUpHere set; caching that would let a failing ticket skip its way to
  //     a green log line.
  //   - the OWNER's pass. A non-owner pass skips the dirty-work check by design, so its
  //     "green" says nothing about whether the owner left work uncommitted. Caching it let
  //     a foreign pass hand the owner a free skip past its own rejection.
  if (!gaveUpHere && wt === owner) recordGreen(ctx, wt);
  progress(`[validate:${label}] checks passed`);
  ctx.log(`OK wt=${wt}`);
  return { ok: true };
}
