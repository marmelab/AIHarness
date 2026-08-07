#!/usr/bin/env node
// PreToolUse(Agent) — block accidental duplicate dispatches. Two concerns,
// grouped in one hook because both are "don't dispatch the same thing twice":
//
//  1. planner: at most ONE `planner` dispatch per orchestrator instance.
//     A 2nd planner overwrites the TASK-*.json the wave is already running against,
//     and two opus planners on one ticketsDir is also the most expensive duplicate
//     the harness can make.
//
//  2. developer / quality-reviewer / merger: debounce identical re-dispatches
//     inside a short window. A foreground Agent call is SUPPOSED to block and
//     return the subagent's final line inline; in some runtimes (interactive
//     Claude Code) it instead returns immediately with "Async agent launched …
//     agentId: <id>" and the real result arrives later as a task-notification.

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { runStandalone } from "./lib/hook-chain.mjs";
import { parseDispatch } from "./lib/dispatch-parse.mjs";
import { pipelineRoleSet, debounceRoleSet } from "./lib/teams.mjs";
import { isExplicitlyBackgrounded } from "./lib/dispatch-parse.mjs";

// Sourced from harness.config.json (config.roles debounce/pipeline flags) via
// teams.mjs, so these sets and force-foreground's share one source of truth.
const DEBOUNCE_ROLES = debounceRoleSet();
const PIPELINE_ROLES = pipelineRoleSet();
const DEBOUNCE_WINDOW_MS = 90 * 1000;
const PLANNER_STALE_MS = 60 * 60 * 1000;
// How long a dispatched planner is presumed to still be working. An opus planner takes
// several minutes to explore and write its tickets, so anything inside this window with no
// tickets on disk is "in flight", not "dead".
const PLANNER_INFLIGHT_MS = 10 * 60 * 1000;

const sha = (s) => createHash("sha1").update(s).digest("hex").slice(0, 16);

export function check(input, ctx) {
  const d = parseDispatch(input);
  const prompt = String(input.tool_input?.prompt ?? "");

  // Without a caller agent_id we can't scope a marker safely: allow rather than
  // risk over-blocking the only dispatch.
  const caller = ctx.agentId;
  if (!caller) return;

  const markerDir = join(ctx.sessionDir, "breaker");
  try {
    mkdirSync(markerDir, { recursive: true });
  } catch {
    return; // can't persist a marker -> don't risk blocking a real dispatch
  }

// Only debounce dispatches that will actually PROCEED. An explicitly-backgrounded one is
// denied by force-foreground-orchestrator-dispatch and re-issued, so recording a marker for
// it would reject the corrective retry as a "duplicate" (seen once: the planner never ran,
// yet its marker blocked the retry for 60 min).
//
// This used to read `run_in_background !== false`, which silently disabled the whole
// debounce: a nested subagent's Agent tool does not expose the parameter, so the condition
// was always true and every pipeline role exited here. Observed as two planner dispatches
// twelve seconds apart with no log line from this hook at all. The predicate is shared with
// force-foreground now, so the two cannot drift apart again.
  const childRole = PIPELINE_ROLES.has(d.subagentType)
    ? d.subagentType
    : PIPELINE_ROLES.has(d.role)
      ? d.role
      : "";
  if (childRole && isExplicitlyBackgrounded(input)) return;

  if (d.subagentType === "planner") return checkPlanner(ctx, d, { prompt, caller, markerDir });
  if (DEBOUNCE_ROLES.has(d.subagentType))
    return checkDebounce(ctx, d, { prompt, caller, markerDir });
}

// ---- Concern 1: at most one planner per request -------------------------------
function checkPlanner(ctx, d, { prompt, caller, markerDir }) {
  // The STATE A planner template writes `TICKETS_DIR=<path>` (equals);
  // parseDispatch only captures the `TICKETS_DIR:` (colon) form, so accept both.
  // Kept for the log line and for the plan lookup, NOT for the key.
  const promptTicketsDir =
    (prompt.match(/^TICKETS_DIR[:=]\s*(\S+)/m) || [])[1] || "";
  const ticketsDir = d.ticketsDir || promptTicketsDir || ctx.ticketsDir || "";

  // Keyed on the CALLER ALONE. The invariant is "one planning round per orchestrator
  // instance", and folding ticketsDir into the key made the guard trivially avoidable: a
  // dispatch that simply omits TICKETS_DIR falls back to the session default, hashes to a
  // different key, and sails past a marker that already exists. A path is caller-controlled
  // input, so it cannot be part of the identity of the thing being rate-limited.
  const marker = join(markerDir, `planner-${sha(caller)}`);

  // The sanctioned way to plan again: say so. Without an escape hatch this guard is
  // unsatisfiable for a whole stale window, and an unsatisfiable guard is a wedge
  // (rules/hook-authoring.md). REPLAN is explicit, auditable in the log, and the
  // planner refuses to overwrite tickets without it too (agents/planner.md).
  const isReplan = /(^|\s)REPLAN(\s|:|$)/m.test(prompt);

  if (existsSync(marker)) {
    try {
      // Stale if older than the window — OR if its mtime is in the FUTURE
      // (clock skew / NFS drift): a negative age would otherwise read as "fresh"
      // forever and permanently block re-planning, with no escape (the
      // orchestrator can't rm a breaker marker — bash-guard blocks that).
      const age = Date.now() - statSync(marker).mtimeMs;
      if (age > PLANNER_STALE_MS || age < 0) unlinkSync(marker);
    } catch {
      // ignore — fall through to the existence check
    }
  }
  // A marker records that a planner was DISPATCHED, which is not the same as "a plan
  // exists". A planner that died before writing anything (observed: lost to a transient API
  // 529 overload) leaves the marker behind with no tickets, and refusing the retry then
  // wedges planning for the whole stale window with nothing to show for it.
  //
  // The invariant this guard actually protects, per its own message, is "never overwrite an
  // existing plan". So it fires only when a plan exists: no TASK-*.json means there is
  // nothing to overwrite and the retry is legitimate.
  const planExists = () => {
    for (const dir of [ticketsDir, ctx.sessionDir]) {
      if (!dir || !existsSync(dir)) continue;
      try {
        if (readdirSync(dir).some((f) => /^TASK-\d+\.json$/.test(f)))
          return true;
      } catch {
        /* unreadable -> treat as no plan, the retry is the safer outcome */
      }
    }
    return false;
  };

  if (existsSync(marker) && !planExists() && !isReplan) {
    // "Marker present but no plan" has two causes that need opposite answers, and mtime is
    // what tells them apart: a planner still working (it needs several minutes to write
    // TASK-*.json) versus one that died before writing anything. Allowing both is what let
    // a re-dispatch 27 seconds after the first one through.
    let age = Infinity;
    try {
      age = Date.now() - statSync(marker).mtimeMs;
    } catch {
      /* unreadable mtime -> treat as dead, fall through to refresh + allow */
    }
    if (age >= 0 && age < PLANNER_INFLIGHT_MS) {
      ctx.block({
        reason:
          `A \`planner\` was dispatched ${Math.round(age / 1000)}s ago for this request and has not written its tickets yet. ` +
          `It is STILL RUNNING: a planner takes several minutes, and its dispatch acknowledgement ("Async agent launched ... agentId") means dispatched, not finished. ` +
          `You WILL be re-woken by its task-notification. Wait for it. Do NOT re-dispatch the planner, and do NOT dispatch a probe or test agent to find out whether the first one is alive. ` +
          `Two planners on one TICKETS_DIR overwrite each other's TASK-*.json while the plan gate is being presented. ` +
          `If you are certain the first planner is dead and you must plan again, re-dispatch with REPLAN in the prompt. ` +
          `(marker: ${marker})`,
        log: `BLOCK planner in flight caller=${caller} age=${Math.round(age / 1000)}s marker=${marker}`,
      });
    }
    // Genuinely dead (or a clock that went backwards): refresh the marker so the retry is
    // itself recorded, then let it through.
    try {
      writeFileSync(marker, `${caller} ${ticketsDir}\n`);
    } catch {
      /* best effort */
    }
    return ctx.allow(
      `planner retry allowed: marker ${Math.round(age / 1000)}s old and no plan was produced (ticketsDir=${ticketsDir || "(session default)"})`,
    );
  }

  if (existsSync(marker) && !isReplan) {
    ctx.block({
      reason:
        `A \`planner\` has ALREADY been dispatched for this request AND a plan exists (TICKETS_DIR=${ticketsDir || "(session default)"}). ` +
        `Do NOT dispatch a second planner: a re-plan overwrites the existing TASK-*.json while the wave may already be running against them. ` +
        `Read the tickets already in TICKETS_DIR and continue into STATE B with them. ` +
        `If the first plan looks wrong, fix the ticket JSON in place rather than re-running the planner. ` +
        `If a re-plan is genuinely the right call, re-dispatch with REPLAN in the prompt. ` +
        `(marker: ${marker})`,
      log: `BLOCK 2nd planner caller=${caller} ticketsDir=${ticketsDir || "(default)"} marker=${marker}`,
    });
  }
  try {
    writeFileSync(marker, `${caller} ${ticketsDir}\n`);
  } catch {
    // if we can't record the marker, still allow this (first) planner through
  }
  ctx.log(
    `ALLOW ${isReplan ? "REPLAN" : "1st"} planner caller=${caller} ticketsDir=${ticketsDir || "(default)"} marker=${marker}`,
  );
}

// ---- Concern 2: debounce duplicate developer/reviewer/merger dispatches -------
function checkDebounce(ctx, d, { prompt, caller, markerDir }) {
  // Key on the ticket identity AND the prompt content. The async-ack duplicate
  // re-issues the IDENTICAL dispatch prompt, so an identical (caller, role,
  // ticket, prompt) inside the window collides and is blocked. A genuine retry
  // carries different prompt text (RETRY_FEEDBACK / FIX findings) → different
  // key → allowed even inside the window (keying on the TASK id alone would
  // wrongly debounce a fast-failing ticket's legitimate re-dispatch). The
  // TASK id, when present, is kept as the human-readable label for messages.
  const label = d.taskId || `prompt:${sha(prompt)}`;
  const idPart = `${d.taskId || "_"}::${sha(prompt)}`;
  const marker = join(
    markerDir,
    `dispatch-${sha(`${caller}::${d.subagentType}::${idPart}`)}`,
  );

  if (existsSync(marker)) {
    let ageMs = Infinity;
    try {
      ageMs = Date.now() - statSync(marker).mtimeMs;
    } catch {
      // unreadable mtime → treat as stale, fall through to refresh + allow
    }
    if (ageMs < DEBOUNCE_WINDOW_MS) {
      ctx.block({
        reason:
          `A \`${d.subagentType}\` dispatch for ${label} was made ${Math.round(ageMs / 1000)}s ago and is still in flight. ` +
          `A dispatch can return immediately as "Async agent launched … agentId: <id>" WITHOUT blocking — that acknowledgement means "dispatched", not "done". ` +
          `Do NOT re-dispatch the same role for the same ticket: wait for its task-notification, then read the agent's output file and parse its contract line. ` +
          `Two ${d.subagentType}s on the same ticket race on one worktree/branch — that is always a bug.`,
        log: `BLOCK duplicate ${d.subagentType} key=${idPart} age=${Math.round(ageMs / 1000)}s caller=${caller}`,
      });
    }
  }
  try {
    writeFileSync(marker, `${caller} ${d.subagentType} ${idPart}\n`);
  } catch {
    // can't record → allow this dispatch through
  }
  ctx.log(`ALLOW ${d.subagentType} dispatch key=${idPart} caller=${caller}`);
}

runStandalone(import.meta.url, "block-duplicate-dispatch", check);
