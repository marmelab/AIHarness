#!/usr/bin/env node
// PreToolUse(Bash) dispatcher: every Bash guard, in ONE node process.
//
// Registered once in hooks.json in place of the seven individual commands. The guards
// are unchanged and each keeps its own `[name]` log prefix; what disappears is six node
// startups and six config loads per Bash call.
//
// ORDER IS THE CONTRACT, and it is the order the seven were registered in. A guard that
// refuses ends the process, so everything after it is skipped: that is correct for a
// denied tool call (a refused dispatch must not go on to have later side effects applied
// to it) and it is why the cheap textual guards run before pre-pr-checks, which shells
// out to the project's typecheck.

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
