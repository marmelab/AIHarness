#!/usr/bin/env node
// PreToolUse(Bash) - per-subagent circuit breaker. It exists to stop a subagent that is
// spinning, and nothing else. The main session (no agent_id) is never throttled.
//
// The budget is a SLIDING WINDOW, not a lifetime total: at most WINDOW_LIMIT counted work
// calls in any WINDOW_MS. A lifetime counter cannot tell "stuck" from "long-lived", so it
// blocked an orchestrator making one Bash call every two minutes over an hour and three
// quarters, during the last mandated step of its run, which therefore never happened. A
// loop hits 30 calls in ten minutes trivially; healthy work paced across an hour never
// does. Ageing timestamps out is also what makes the counter self-healing, so there is no
// staleness rule to get wrong (the old one keyed on file mtime, which every write
// refreshed, so a long-lived agent never reset).
//
// What counts is decided by lib/bash-classify.mjs: read-only exploration, git
// plumbing/commit and progress-log appends are free.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runStandalone } from "./lib/hook-chain.mjs";
import { TMP_ROOT } from "./lib/paths.mjs";
import { isFreeCommand } from "./lib/bash-classify.mjs";

// Overridable so a test can exercise the window without waiting minutes.
const WINDOW_MS = Number(process.env.BREAKER_WINDOW_MS) || 10 * 60 * 1000;
const WINDOW_LIMIT = Number(process.env.BREAKER_WINDOW_LIMIT) || 30;

// One epoch-ms timestamp per line. Anything unparseable is dropped, which also migrates
// the old format (a single lifetime integer) harmlessly: it is not a plausible timestamp.
const readWindow = (counterFile, now) => {
  if (!existsSync(counterFile)) return [];
  try {
    return readFileSync(counterFile, "utf8")
      .split("\n")
      .map((l) => parseInt(l.trim(), 10))
      .filter((t) => Number.isFinite(t) && t > 1_600_000_000_000 && t <= now)
      .filter((t) => now - t < WINDOW_MS);
  } catch {
    return [];
  }
};

export function check(input, ctx) {
  // Per-subagent breaker only. The main session (no agent_id) is never throttled.
  if (!ctx.agentId) return;

  // Free calls exit before any bookkeeping. They used to log a line each, which produced
  // hundreds of `free:` lines per session and buried everything else; the counted calls
  // below are the ones worth a record.
  if (isFreeCommand(input.tool_input?.command)) return;

  const key = `sub-${ctx.agentId}`;
  const keyHash = createHash("sha1").update(key).digest("hex").slice(0, 16);

  let counterDir = join(ctx.sessionDir, "breaker");
  try {
    mkdirSync(counterDir, { recursive: true });
  } catch {
    counterDir = TMP_ROOT;
  }
  const counterFile = join(counterDir, `bash-count-${keyHash}`);

  const now = Date.now();
  const recent = readWindow(counterFile, now);
  recent.push(now);

  try {
    // Bounded write: only the window is kept, so the file cannot grow without limit.
    writeFileSync(counterFile, recent.join("\n") + "\n");
  } catch {
    // ignore: a breaker that cannot persist must not block real work
  }

  if (recent.length > WINDOW_LIMIT) {
    const spanS = Math.round((now - recent[0]) / 1000);
    ctx.block({
      reason:
        `Circuit breaker: ${recent.length} work-level Bash calls in the last ${spanS}s, which is a loop rather than progress. ` +
        `Read-only exploration, git plumbing and progress-log appends are NOT counted, so this is ${recent.length} calls that each did something. ` +
        `Stop and report where you are blocked so the orchestrator can re-dispatch with a fresh context. ` +
        `The budget is a rolling window: it frees itself as the oldest calls age past ${Math.round(WINDOW_MS / 60000)} minutes.`,
      log: `count=${recent.length}/${WINDOW_LIMIT} span=${spanS}s key=${key}`,
    });
  }

  // One line per COUNTED call, so `grep '\[circuit-breaker\]' hooks.log` shows the work
  // pace and nothing else.
  ctx.log(`count=${recent.length}/${WINDOW_LIMIT} key=${key} hash=${keyHash}`);
}

runStandalone(import.meta.url, "circuit-breaker", check);
