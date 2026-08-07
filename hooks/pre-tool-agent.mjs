#!/usr/bin/env node
// PreToolUse(Agent) dispatcher: every dispatch guard, in ONE node process.
//
// Registered once in hooks.json in place of the eight individual commands. The guards
// are unchanged and each keeps its own `[name]` log prefix; what disappears is seven
// node startups and seven config loads per dispatch.
//
// ORDER IS THE CONTRACT, and it is the order the eight were registered in. Two
// consequences worth naming, both of them the point rather than side effects:
//
//   - setup-worktree runs LAST, so every refusal is decided before a worktree is
//     created for a dispatch that is not going to happen.
//   - record-merger-stage writes its authorization marker only for a dispatch that got
//     past the merger gates above it, so a refused merger leaves no marker behind.

import { runChain } from "./lib/hook-chain.mjs";
import { check as blockNestedOrchestrator } from "./block-nested-orchestrator.mjs";
import { check as blockDuplicateDispatch } from "./block-duplicate-dispatch.mjs";
import { check as blockMergerWithoutReview } from "./block-merger-without-review.mjs";
import { check as blockPromoteUnmerged } from "./block-promote-unmerged.mjs";
import { check as recordMergerStage } from "./record-merger-stage.mjs";
import { check as enforceDevDispatch } from "./enforce-dev-dispatch.mjs";
import { check as forceForeground } from "./force-foreground-orchestrator-dispatch.mjs";
import { check as setupWorktree } from "./setup-worktree.mjs";

runChain([
  ["block-nested-orchestrator", blockNestedOrchestrator],
  ["block-duplicate-dispatch", blockDuplicateDispatch],
  ["block-merger-without-review", blockMergerWithoutReview],
  ["block-promote-unmerged", blockPromoteUnmerged],
  ["record-merger-stage", recordMergerStage],
  ["enforce-dev-dispatch", enforceDevDispatch],
  ["force-foreground-orchestrator-dispatch", forceForeground],
  ["setup-worktree", setupWorktree],
]);
