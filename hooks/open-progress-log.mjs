#!/usr/bin/env node
// PreToolUse(Agent): create <sessionDir>/harness-progress.log when a dispatch declares
// `PERSONA: technical`, so the technical run's live feed exists whether or not the
// orchestrator cooperates.
//
// It used to be the orchestrator's job alone: orchestrator.md tells it to append each
// milestone with `Bash("echo ... >> harness-progress.log")`. A prompt instruction is not a
// gate, and an orchestrator that skips it leaves a `#technical-harness` run with no live feed
// at all AND no board either, because render-status is gated on that same file existing. The
// harness's own rule is that every gate is a hook rather than an instruction, precisely so it
// fires whether or not the model cooperates; this one had been left as an instruction.
//
// The FILE's existence stays the technical-run gate (a web-chat or normal run must never get
// a board), which is why this is keyed on the dispatch prompt and not created unconditionally.
// The main thread's dispatch of the orchestrator is the first Agent call of the session and
// carries the `PERSONA: technical` line, so the log exists before any agent has stopped.
//
// Never blocks: a missing progress log must not stop a dispatch.

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runStandalone } from "./lib/hook-chain.mjs";

const TECHNICAL = /^\s*PERSONA:\s*technical\s*$/im;

export function check(input, ctx) {
  const prompt = String(input?.tool_input?.prompt ?? "");
  if (!TECHNICAL.test(prompt)) return;
  let file;
  try {
    file = join(ctx.sessionDir, "harness-progress.log");
  } catch {
    return; // no session state to key on
  }
  if (existsSync(file)) return;
  try {
    mkdirSync(ctx.sessionDir, { recursive: true });
    const stamp = new Date().toISOString().slice(11, 19);
    appendFileSync(
      file,
      `${stamp} harness started (PERSONA: technical) — session ${ctx.sessionShort}\n`,
    );
    ctx.allow(`opened harness-progress.log for the technical run`);
  } catch {
    // best-effort: a view must never break a dispatch
  }
}

runStandalone(import.meta.url, "open-progress-log", check);
