#!/usr/bin/env node
// PreToolUse(Bash) dispatcher: every Bash guard, in ONE node process.
//
// Registered once in hooks.json in place of the seven individual commands. The guards
// are unchanged and each keeps its own `[name]` log prefix; what disappears is six node
// startups and six config loads per Bash call.
//
// ORDER IS THE CONTRACT, and it is the order the seven were registered in. A guard that
// refuses ends the process, so everything after it is skipped: that is correct for a
// denied tool call, since a refused command must not go on to have later side effects
// (the breaker's counters, the merger-stage record) applied to it.
//
// One guard is not textual: pre-pr-checks shells out to the project's validation steps,
// and it sits SECOND, so five guards run after it and one process timeout now takes them
// all instead of one. What bounds that is who it runs for: it returns immediately unless
// the caller is the human main thread AND the command is `git push` / `gh pr create`. On
// that one path the guards behind it are keyed on agent identities the caller does not
// have. Moving it last would fix the shape rather than the exposure, and would cost the
// property above: the breaker would count a push pre-pr-checks then refuses.

import { runChain } from "./lib/hook-chain.mjs";
import { check as bashGuard } from "./bash-guard.mjs";
import { check as prePrChecks } from "./pre-pr-checks.mjs";
import { check as blockDockerContainers } from "./block-docker-containers.mjs";
import { check as circuitBreaker } from "./circuit-breaker.mjs";
import { check as blockOrchestratorMerge } from "./block-orchestrator-merge.mjs";
import { check as blockWaveMergerPromote } from "./block-wave-merger-promote.mjs";
import { check as restrictDocumentatorBash } from "./restrict-documentator-bash.mjs";

runChain([
  ["bash-guard", bashGuard],
  ["pre-pr-checks", prePrChecks],
  ["block-docker-containers", blockDockerContainers],
  ["circuit-breaker", circuitBreaker],
  ["block-orchestrator-merge", blockOrchestratorMerge],
  ["block-wave-merger-promote", blockWaveMergerPromote],
  ["restrict-documentator-bash", restrictDocumentatorBash],
]);
