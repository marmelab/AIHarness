#!/usr/bin/env node
// SubagentStop(developer): append the developer's own contract line to the technical
// run's progress log, so the orchestrator no longer spends a turn echoing it.
//
// orchestrator.md used to tell the orchestrator to log every developer `DONE` itself
// with `Bash("echo ... >> harness-progress.log")`. Measured on one 84-minute run: 29 of
// the orchestrator's 48 tool calls were such echoes, and each one is a separate turn
// that re-reads its whole context (85K-120K tokens at that point in the run) to write a
// single line of text. Six of those 29 were developer results, which are already sitting
// in the payload this hook receives.
//
// Same reasoning as record-review-verdict: a milestone the harness can observe should not
// depend on an agent remembering to echo it. Unlike that hook this one writes NO flag and
// gates nothing -- it is purely the live feed, so every failure path is silent.
//
// Informational, therefore fail-open: no identity, no task, no parseable contract line ->
// nothing written, exit 0. SubagentStop cannot block anyway.

import { readFileSync } from "node:fs";
import { createHookContext } from "./lib/context.mjs";
import { getFirstTaskId, isDeveloper } from "./lib/teams.mjs";
import { isPhantomStop, readAgentMeta } from "./lib/agent-meta.mjs";
import { appendProgress } from "./lib/progress-log.mjs";
import { lastAssistantText } from "./lib/verdict.mjs";
import { parseDeveloperContract } from "./lib/dev-contract.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
const ctx = createHookContext(input, "record-developer-done");

// The runtime fires a stop of its own every ~32 s while an agent runs. It names no agent,
// and its "last assistant text" is a mid-turn snapshot with no contract line yet. Counted
// by record-review-verdict, ignored here.
if (isPhantomStop(input)) process.exit(0);

// Identity from the payload / spawn meta only, never recovered by scanning a transcript:
// every SubagentStop hook runs on every stop, so the orchestrator's own stop reaches this
// hook too, and its transcript holds the developer dispatch prompts IT wrote (`ROLE:
// developer`, `TASK_ID:`) plus every `DONE:` line it parsed. Scanning that would make the
// orchestrator's summary able to forge a developer milestone.
const meta = readAgentMeta(input);
const identity =
  [ctx.agentName, ctx.agentType, meta ? meta.agentType : ""].find(Boolean) || "";
if (!identity || !isDeveloper(identity)) process.exit(0);

// The ticket: the suffixed agent identity (`developer-TASK-003`), else the spawn meta's
// dispatch description ("Implement TASK-003"). A SIMPLE-flow or fix-round developer has no
// ticket at all -- it is dispatched with an inline CHANGE_REQUEST -- so an absent id is
// normal here and the line is keyed `simple` rather than dropped.
let task = "";
for (const name of [ctx.agentName, ctx.agentType].filter(Boolean)) {
  const m = getFirstTaskId(name);
  if (m) {
    task = m;
    break;
  }
}
if (!task && meta) {
  const m = meta.description.match(/TASK-\d+/);
  if (m) task = m[0];
}

const contract = parseDeveloperContract(lastAssistantText(input));
if (!contract) {
  // No contract line yet (transcript not flushed, or the agent stopped mid-turn). The
  // orchestrator still learns the result from the dispatch's return value, so a missing
  // feed line costs nothing and must not be guessed at.
  ctx.log(`role=developer task=${task || "simple"} contract=UNPARSEABLE, nothing logged`);
  process.exit(0);
}

// Truncated: the feed is read as a `tail -f` and by the board's "Recent activity", where a
// full `files=[...]` list of a large ticket wraps into unreadability. The complete line is
// in the orchestrator's own report and in the ticket JSON.
const detail =
  contract.detail.length > 240
    ? `${contract.detail.slice(0, 237)}...`
    : contract.detail;

appendProgress(
  ctx.sessionDir,
  `[dev:${task || "simple"}] ${contract.result}${detail ? ` ${detail}` : ""}`,
);
ctx.log(`role=developer task=${task || "simple"} contract=${contract.result}`);
process.exit(0);
