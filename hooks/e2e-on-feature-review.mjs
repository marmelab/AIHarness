#!/usr/bin/env node
// SubagentStop - the ONLY place the e2e suite is launched. Two triggers.
//
// 1. FEATURE REVIEW. The end-of-feature `MODE: feature-review` dispatch, and only when
//    that review APPROVED, so a BLOCKED review that sends the work back to a developer
//    never pays for a 10-minute suite.
//
//    The gate is the reviewer's VERDICT, parsed through lib/verdict.mjs, the same parser
//    record-review-verdict uses to write the flag. Reading the verdict rather than waiting
//    for that flag to appear is deliberate: this hook and record-review-verdict are
//    registered on the same SubagentStop matcher, and depending on one hook's file write
//    being visible to another is a race whatever the runtime's execution order turns out
//    to be. The flag is consulted only as a fallback for an UNPARSEABLE verdict.
//
// 2. MERGER, after a fix for a red suite lands. All three must hold: the FEATURE flag
//    exists (so a feature review has already approved), the last result says `failed`, and
//    its sessionSha is not the session branch's current head (so something was merged
//    since). That is exactly the state after "fix the failing spec, merge it".
//
//    Without this, re-running the suite meant re-running a full opus feature-review whose
//    only purpose was to re-trigger the hook. Each fix round then cost a review it did not
//    need, and the fix-round budget was spent on paying for re-runs instead of on bugs. A
//    feature review is now only re-run when the fix plausibly invalidates the review
//    itself, which is a judgement the orchestrator makes, not a mechanical requirement.
//
// The suite runs on the INTEGRATED session worktree (never $REPO, which sits on the base
// branch), via the deploy adapter's e2e-smoke.sh: isolated slot-leased Supabase,
// guaranteed teardown, graceful SKIP when the host cannot hold a stack.
//
// The result cannot be handed to the stopping agent (fixing e2e is neither a reviewer's
// nor a merger's job), so it lands in <session_dir>/e2e-result.json plus the progress log,
// and the orchestrator reads it. This hook never blocks a stop.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHookContext } from "./lib/context.mjs";
import { readAgentMeta } from "./lib/agent-meta.mjs";
import { harnessFile } from "./lib/paths.mjs";
import { appendProgress } from "./lib/progress-log.mjs";
import { bash } from "./lib/process.mjs";
import { git } from "./lib/git.mjs";
import { isFeatureReview } from "./lib/review-mode.mjs";
import { FEATURE_KEY, reviewFlag } from "./lib/reviews.mjs";
import { isMerger } from "./lib/teams.mjs";
import {
  sessionBaseBranch,
  sessionBranch,
  sessionWorktreePath,
} from "./lib/topology.mjs";
import { reviewerVerdict } from "./lib/verdict.mjs";
import {
  e2eResultPath,
  failureSignature,
  readE2eResult,
} from "./lib/e2e-result.mjs";

// The suite's own budget, deliberately UNDER the hook's timeout in hooks.json (900s). The
// two used to be equal, so a slow suite could be killed by the runtime after this hook had
// already deleted the previous result, leaving "not run" for a suite that did run. Now the
// inner timeout always fires first and this hook always gets to write a truthful result.
// E2E_TIMEOUT_MS overrides it, so a test can exercise the timeout path in a second rather
// than in thirteen minutes.
const E2E_TIMEOUT_MS = Number(process.env.E2E_TIMEOUT_MS) || 13 * 60 * 1000;

const classify = (r, output) => {
  if (r.error && r.error.code === "ETIMEDOUT") return "failed";
  return r.status !== 0
    ? "failed"
    : /^SKIP:/m.test(output)
      ? "skipped"
      : "passed";
};

const input = JSON.parse(readFileSync(0, "utf8"));
const ctx = createHookContext(input, "e2e-on-feature-review");

const sessionRef = sessionBranch(ctx);
const headSha = () => git(["rev-parse", sessionRef]).stdout.trim();

// --- which trigger, if any ----------------------------------------------------------
// Read the previous result BEFORE anything is deleted: trigger 2 is a decision about it.
const previous = readE2eResult(ctx);

const featureFlag = () =>
  existsSync(reviewFlag(ctx, FEATURE_KEY, "quality-reviewer"));

const mergerFixLanded = () => {
  const meta = readAgentMeta(input);
  if (!meta || !isMerger(meta.agentType)) return false;
  if (!featureFlag()) return false; // no feature review has approved yet: the wave is still running
  if (!previous || previous.status !== "failed") return false;
  const head = headSha();
  return Boolean(head && previous.sessionSha && previous.sessionSha !== head);
};

let trigger = "";
if (isFeatureReview(input)) {
  trigger = "feature-review";
} else if (mergerFixLanded()) {
  trigger = "merger-fix";
}
if (!trigger) process.exit(0);

if (trigger === "feature-review") {
  // A feature review just ran, so any result from an earlier round describes code that has
  // since changed. Drop it before deciding, so the orchestrator can never read a stale
  // verdict as current: from here on, a missing file means "not run this round".
  try {
    rmSync(e2eResultPath(ctx), { force: true });
  } catch {
    // best-effort
  }

  // APPROVED runs the suite; REJECTED does not. An unparseable verdict falls back to the
  // flag, which is the only case where an agent-written flag still matters.
  const verdict = reviewerVerdict(input);
  const approved = verdict === "APPROVED" || (verdict === "" && featureFlag());
  if (!approved) {
    ctx.accept(
      `feature-review not APPROVED (verdict=${verdict || "UNPARSEABLE"}) -> e2e not launched`,
    );
  }
}

const src = sessionWorktreePath(ctx);
const script = harnessFile("scripts", "e2e-smoke.sh");
if (!existsSync(src))
  ctx.accept(`no session worktree at ${src} -> e2e skipped`);
if (!existsSync(script)) ctx.accept(`no ${script} -> e2e skipped`);

// --- run the changed specs first ----------------------------------------------------
// The specs this session added or touched, against the branch it forked from. e2e-smoke.sh
// runs these before the full suite inside ONE stack boot, so a broken new spec surfaces
// right after boot instead of after everything else has run. Best-effort: an empty list
// just means "full suite", which is the previous behaviour.
const changedSpecs = () => {
  const base = sessionBaseBranch(ctx);
  const range =
    git(["show-ref", "--verify", "--quiet", `refs/heads/${base}`]).status === 0
      ? `${base}...${sessionRef}`
      : "";
  if (!range) return [];
  const r = git(["diff", "--name-only", range, "--", "e2e/"]);
  if (r.status !== 0) return [];
  return r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((f) => /\.spec\.[cm]?[jt]sx?$/.test(f));
};

const specs = changedSpecs();

// --- a truthful result exists from the moment the suite starts ----------------------
// If this process is killed (runtime timeout, host restart), the file left behind says
// `running` with a start time, which a reader can tell apart from "never ran". Previously
// the only states on disk were "the old result" and "nothing".
const writeResult = (payload) => {
  try {
    writeFileSync(
      e2eResultPath(ctx),
      JSON.stringify({ kind: "e2e-result", ...payload }, null, 2),
    );
  } catch {
    // best-effort: the progress line and the hook log still record the outcome
  }
};

const startedAt = new Date().toISOString();
writeResult({
  status: "running",
  trigger,
  source: src,
  sessionSha: headSha(),
  startedAt,
  specsFirst: specs,
});

appendProgress(
  ctx.sessionDir,
  `[e2e] suite starting on the session worktree (${trigger})...`,
);

const r = bash(
  `E2E_SMOKE_SRC='${src}' E2E_SMOKE_SPECS='${specs.join(" ")}' bash '${script}' 2>&1`,
  { cwd: ctx.repo, timeout: E2E_TIMEOUT_MS },
);
const timedOut = Boolean(r.error && r.error.code === "ETIMEDOUT");
const output =
  String(r.stdout || "") +
  (timedOut
    ? `\ne2e-smoke: TIMEOUT after ${E2E_TIMEOUT_MS / 60000} minutes, the suite was killed.`
    : "");
const status = classify(r, output);

writeResult({
  status,
  trigger,
  source: src,
  // The session-branch commit the suite actually ran against. A session serves several
  // requests, so this is what lets a reader tell "this verdict is about the code as it
  // stands" from "this verdict predates later merges". It is also what the merger trigger
  // compares against to decide a fix has landed since.
  sessionSha: headSha(),
  // WHICH failure this is, so the orchestrator can budget fix rounds per distinct bug
  // instead of globally. "" for a pass, a skip, or an unrecognisable failure.
  failureSignature: status === "failed" ? failureSignature(output) : "",
  timedOut,
  specsFirst: specs,
  startedAt,
  finishedAt: new Date().toISOString(),
  output: output.split("\n").slice(-40).join("\n"),
});

appendProgress(ctx.sessionDir, `[e2e] suite ${status}`);
ctx.accept(`e2e ${status} trigger=${trigger} src=${src} specs=${specs.length}`);
