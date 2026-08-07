// Resolve WHO just stopped, from a SubagentStop payload.
//
// Every SubagentStop guard needs this, and the runtime makes it hard:
//
//   - `agent_type` in the payload is EMPTY, so the hooks.json matchers do not filter.
//     Every SubagentStop hook fires on every stop, and each one has to work out for
//     itself whether the stop is its business.
//   - `transcript_path` points at the MAIN SESSION transcript, not the stopping
//     agent's. A sibling `<transcript>.meta.json` derived from it therefore never
//     exists, so that is not a way to identify anyone.
//
// The spawn-time meta DOES exist, one directory down from the main transcript:
//
//     <dirname(main transcript)>/<session-id>/subagents/agent-<agent-id>.meta.json
//
// next to that agent's own transcript, `agent-<agent-id>.jsonl`. It carries
// `agentType` (bare OR namespaced, e.g. `aiharness:orchestrator`, so always compare
// through `teams.mjs`) and the dispatch `description`.
//
// Three strategies, in order of decreasing confidence, and the result says which one
// answered (`source`) so a caller can refuse to act destructively on a guess:
//
//   agent-id        the payload's agent id names the meta file. Authoritative.
//   sibling         the payload really did hand us the agent's own transcript.
//   newest-dispatch a GUESS: newest harness-dispatched subagent transcript in the
//                   session. Only reached when there is no agent id at all.
//
// When none of them answers, the caller gets null AND the session's hooks.log gets one
// loud WARN. Unresolvable identity turns every guard behind it into a no-op, and a guard
// that treats "not my role" as "not my business" cannot report that: without the WARN the
// whole family degrades in silence.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { sessionDirFromEnv } from "./config.mjs";
import { REPO, TMP_ROOT, sanitizePath } from "./paths.mjs";

// A path component we are about to build a filesystem path from. Rejects anything
// with a separator or a `..`, so a hostile session/agent id cannot escape the
// transcript directory.
const SAFE_COMPONENT = /^[\w.-]+$/;
const isSafe = (s) => SAFE_COMPONENT.test(s) && !s.includes("..");

// The harness dispatch contract, as it appears in a dispatch prompt. Used to tell a
// harness agent's transcript from one of the runtime's own helpers (Explore,
// general-purpose), which carry no contract.
const DISPATCH_MARKER = /TICKET_FILE|MODE:|TASK_ID/;

const payloadTranscript = (payload) =>
  String(
    (payload && (payload.agent_transcript_path || payload.transcript_path)) ||
      "",
  );

// The payload field carrying the stopping agent's id. PreToolUse exposes it as
// `agent_id` (that is what ctx.agentId reads), so accept that first and tolerate the
// two other spellings rather than depending on one the runtime may rename.
const agentIdOf = (payload) => {
  for (const key of ["agent_id", "agentId", "agent_session_id"]) {
    const value = payload && payload[key];
    if (value) return String(value).trim();
  }
  return "";
};

const sessionIdOf = (payload) =>
  String((payload && payload.session_id) || "").trim();

// <main-transcript-dir>/<session-id>/subagents: where the runtime writes each
// subagent's transcript and its spawn meta. Three candidates because the payload can
// hand us any of three things, and only one of them is the documented case:
// the main transcript (measured), the agent's own transcript (some runtimes / every
// test fixture), or a main transcript whose session id the payload omits.
const subagentsDir = (payload) => {
  const tp = payloadTranscript(payload);
  if (!tp) return "";
  const dir = dirname(tp);
  const sessionId = sessionIdOf(payload);
  const candidates = [];
  if (basename(dir) === "subagents") candidates.push(dir);
  if (sessionId && isSafe(sessionId))
    candidates.push(join(dir, sessionId, "subagents"));
  // Session id absent from the payload: the main transcript's own file name IS it.
  candidates.push(join(tp.replace(/\.jsonl$/, ""), "subagents"));
  return candidates.find((c) => existsSync(c)) || "";
};

const parseMeta = (metaPath) => {
  try {
    const meta = JSON.parse(readFileSync(metaPath, "utf8"));
    return {
      agentType: String(meta.agentType || ""),
      description: String(meta.description || ""),
    };
  } catch {
    return null;
  }
};

const resolved = (meta, source, transcriptPath, metaPath) =>
  meta && { ...meta, source, transcriptPath, metaPath };

// Strategy 1: the payload names the agent, so the meta file name is known exactly.
const byAgentId = (payload) => {
  const id = agentIdOf(payload);
  if (!id || !isSafe(id)) return null;
  const dir = subagentsDir(payload);
  if (!dir) return null;
  const stem = id.startsWith("agent-") ? id : `agent-${id}`;
  const metaPath = join(dir, `${stem}.meta.json`);
  if (!existsSync(metaPath)) return null;
  return resolved(
    parseMeta(metaPath),
    "agent-id",
    join(dir, `${stem}.jsonl`),
    metaPath,
  );
};

// Strategy 2: the original lookup. Correct whenever the payload transcript really is
// the stopping agent's own, which is the shape every hook test builds.
const bySiblingMeta = (payload) => {
  const tp = payloadTranscript(payload);
  if (!tp.endsWith(".jsonl")) return null;
  const metaPath = tp.replace(/\.jsonl$/, ".meta.json");
  if (!existsSync(metaPath)) return null;
  return resolved(parseMeta(metaPath), "sibling", tp, metaPath);
};

// The dispatch prompt is the first user event of a subagent transcript.
const firstUserText = (jsonlPath) => {
  let body = "";
  try {
    body = readFileSync(jsonlPath, "utf8");
  } catch {
    return "";
  }
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = (event && event.message) || event;
    if (!msg || msg.role !== "user") continue;
    const content = msg.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content))
      return content
        .map((b) => (b && typeof b.text === "string" ? b.text : ""))
        .join("\n");
    return "";
  }
  return "";
};

// Strategy 3, and it is a GUESS. With concurrent agents the newest transcript is not
// necessarily the one that stopped, so this is a last resort before giving up, and it
// reports source=newest-dispatch precisely so a destructive caller can decline it.
// Requiring a contract marker in the dispatch prompt at least keeps it from latching
// onto one of the runtime's own helper agents.
const byNewestDispatch = (payload) => {
  const dir = subagentsDir(payload);
  if (!dir) return null;
  let names;
  try {
    names = readdirSync(dir).filter((f) => /^agent-.+\.jsonl$/.test(f));
  } catch {
    return null;
  }
  const newestFirst = names
    .map((f) => {
      const p = join(dir, f);
      try {
        return { path: p, mtime: statSync(p).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
  for (const { path } of newestFirst) {
    if (!DISPATCH_MARKER.test(firstUserText(path))) continue;
    const metaPath = path.replace(/\.jsonl$/, ".meta.json");
    if (!existsSync(metaPath)) continue;
    const hit = resolved(
      parseMeta(metaPath),
      "newest-dispatch",
      path,
      metaPath,
    );
    if (hit) return hit;
  }
  return null;
};

// Mirrors createHookContext's derivation, so the WARN lands in the same hooks.log the
// rest of the session writes to.
const sessionDirOf = (payload) => {
  const sessionId =
    sessionIdOf(payload) ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    basename(sessionDirFromEnv() || "") ||
    "default";
  return join(TMP_ROOT, sanitizePath(REPO), sessionId);
};

// One loud line per session, then silence: the sentinel counts the rest so the total is
// recoverable for a later audit without flooding the log. A hook process only ever
// handles one stop, so it also warns at most once regardless of how many times its
// hook asks.
let warnedThisProcess = false;

const warnUnresolvable = (payload) => {
  if (warnedThisProcess) return;
  warnedThisProcess = true;
  const dir = sessionDirOf(payload);
  const sentinel = join(dir, "identity-unresolvable");
  let seen = 0;
  try {
    seen = parseInt(readFileSync(sentinel, "utf8"), 10) || 0;
  } catch {
    seen = 0;
  }
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(sentinel, `${seen + 1}\n`);
  } catch {
    // best-effort
  }
  if (seen > 0) return; // already shouted once this session
  const tp = payloadTranscript(payload);
  try {
    appendFileSync(
      join(dir, "hooks.log"),
      `[${new Date().toISOString()}] [agent-meta] WARN identity-unresolvable ` +
        `agent_id=${agentIdOf(payload) || "absent"} ` +
        `transcript=${tp || "absent"} tp_exists=${Boolean(tp && existsSync(tp))} ` +
        `subagents_dir=${subagentsDir(payload) || "unresolved"}: ` +
        `every SubagentStop guard that gates on identity is degrading on this stop. ` +
        `Later misses this session are counted in ${sentinel}, not logged.\n`,
    );
  } catch {
    // logging must never break a hook
  }
};

// One payload per hook process, and strategy 3 reads every subagent transcript in the
// session, so memoise per payload object.
const memo = new WeakMap();

/**
 * Identity of the agent that just stopped.
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {{ agentType: string, description: string, source: string,
 *            transcriptPath: string, metaPath: string } | null}
 *   agentType may be namespaced (`aiharness:developer`): compare it through
 *   `teams.mjs`, never with `===`. null when identity is unresolvable.
 */
export function readAgentMeta(payload) {
  if (payload && typeof payload === "object" && memo.has(payload))
    return memo.get(payload);
  const hit =
    byAgentId(payload) || bySiblingMeta(payload) || byNewestDispatch(payload);
  if (!hit) warnUnresolvable(payload);
  if (payload && typeof payload === "object") memo.set(payload, hit);
  return hit;
}

// The main session transcript is `<dir>/<session-id>.jsonl`; a subagent's own is
// `<dir>/<session-id>/subagents/agent-<id>.jsonl`. Told apart by the file name, which
// is the only thing the payload gives us to go on.
const isMainSessionTranscript = (payload) => {
  const tp = payloadTranscript(payload);
  if (!tp) return false;
  const base = basename(tp);
  const sessionId = sessionIdOf(payload);
  if (sessionId && base === `${sessionId}.jsonl`) return true;
  return !base.startsWith("agent-") && basename(dirname(tp)) !== "subagents";
};

/**
 * The stopping agent's OWN transcript, or "" when it cannot be resolved.
 *
 * Never falls back to the payload's transcript_path when that is the MAIN session
 * transcript. That file holds every dispatch prompt and every orchestrator message of
 * the session, so scanning it for a `MODE:` line, a `TASK_ID` or a final `APPROVED`
 * answers with whatever came FIRST in the session instead of what this agent did: one
 * `MODE: feature-review` dispatch would then match on every stop that follows, and a
 * verdict would be keyed to the session's first ticket rather than the reviewer's own.
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {string}
 */
export function agentTranscriptPath(payload) {
  const hit = readAgentMeta(payload);
  if (hit && hit.transcriptPath && existsSync(hit.transcriptPath))
    return hit.transcriptPath;
  const tp = payloadTranscript(payload);
  if (!tp || !existsSync(tp) || isMainSessionTranscript(payload)) return "";
  return tp;
}
