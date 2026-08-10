// Resolve WHO just stopped, from a SubagentStop payload.
//
// MEASURED, not inferred. Two audits guessed at this file's inputs and both guessed
// wrong, so a throwaway probe was wired on SubagentStop and four real stops were
// captured, at spawn depth 1 and 2. Every stop carried ALL of:
//
//     agent_id               a4772894a17d69127
//     agent_type             general-purpose          <- populated, not empty
//     agent_transcript_path  <...>/subagents/agent-<id>.jsonl   <- the agent's OWN
//     transcript_path        <...>/<session-id>.jsonl           <- the main session's
//     last_assistant_message ALPHA                    <- present
//
// and none of them set CLAUDE_AGENT_NAME. Three comments in this repo said the opposite
// of three of those lines. They were not merely stale: they are what sent both audits
// looking for a substitute for a field that was there all along. The probe is not kept:
// both WARNs below now log the payload's key NAMES, so the same question answers itself
// from hooks.log the next time the shape changes.
//
// So `agent_type` is read FIRST and is authoritative for the ROLE. A guess that
// contradicts it is wrong by definition, and loses its transcript as well as its name so
// no hook reads another agent's words out of it. That misattribution is not cosmetic: it
// is what let a `MODE: feature-review` line, written by the ORCHESTRATOR into its own
// transcript when it dispatched the reviewer, relaunch the e2e suite on every
// orchestrator stop of a session, 14 runs where 2 were wanted.
//
// `agent_type` names the role and nothing else (`developer`, never `developer-TASK-002`),
// so a caller that needs the ticket still goes to the meta or to the dispatch prompt.
//
// The spawn-time meta sits next to the agent's own transcript:
//
//     <dirname(main transcript)>/<session-id>/subagents/agent-<agent-id>.meta.json
//
// It carries `agentType` (bare OR namespaced, e.g. `aiharness:orchestrator`, so always
// compare through `teams.mjs`) and the dispatch `description`. Fed the payload shape
// above, the agent-id strategy below resolves every agent of a real session correctly;
// it is kept, and kept ahead of the guess, for the runtimes that send less.
//
// Five strategies, in order of decreasing confidence, and the result says which one
// answered (`source`) so a caller can refuse to act destructively on a guess:
//
//   payload-type    the payload's own agent_type. Authoritative for the ROLE.
//   runtime-env     CLAUDE_AGENT_NAME, when a runtime sets it. Same standing.
//   agent-id        the payload's agent id names the meta file. Authoritative.
//   sibling         the payload really did hand us the agent's own transcript.
//   newest-dispatch a GUESS: newest harness-dispatched subagent transcript in the
//                   session. Only reached when nothing above answered.
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
import { bareRole, matchesRole } from "./teams.mjs";

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

/**
 * True when this stop is not one of our agents at all.
 *
 * Run 8bfcc2b0 fired a SubagentStop every ~32 s for eight minutes while the session was
 * WAITING (a planner running, then the plan gate), each carrying a fresh `agent_id`
 * whose transcript and spawn meta were never written and whose `agent_type` was empty.
 * Eleven of them, none during ticket work, while all twenty real agents resolved. So
 * these are the runtime's own book-keeping, not a harness agent.
 *
 * Counting them as failed identity is worse than cosmetic: the session sentinel read 16
 * and every guard logged that it was degrading, which is exactly how a REAL identity
 * failure would have gone unnoticed among them.
 *
 * The discriminator is safe in both directions. A real agent has, by the time it stops,
 * written at least one assistant turn to its own transcript, and the runtime wrote its
 * meta at spawn; so requiring BOTH files absent cannot silence a real agent. And a stop
 * the runtime does name is never phantom, whatever is on disk.
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {boolean}
 */
export const isPhantomStop = (payload) => {
  if (runtimeAgentName(payload)) return false;

  // The payload names the agent's OWN transcript (never the main one, which is a
  // different field). Checked first and on its own, because the phantoms that arrive
  // BEFORE the session has spawned anything leave no `subagents/` directory to resolve,
  // and the check below could not run for them: eight of run f2c1f8a1's nine were of
  // that kind, every one during the pre-dispatch conversation.
  const own = String((payload && payload.agent_transcript_path) || "");
  if (own)
    return (
      !existsSync(own) && !existsSync(own.replace(/\.jsonl$/, ".meta.json"))
    );

  const id = agentIdOf(payload);
  if (!id || !isSafe(id)) return false;
  const dir = subagentsDir(payload);
  if (!dir) return false;
  const stem = id.startsWith("agent-") ? id : `agent-${id}`;
  return (
    !existsSync(join(dir, `${stem}.jsonl`)) &&
    !existsSync(join(dir, `${stem}.meta.json`))
  );
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
        `subagents_dir=${subagentsDir(payload) || "unresolved"} ` +
        `payload_keys=[${payloadKeys(payload)}]: ` +
        `every SubagentStop guard that gates on identity is degrading on this stop. ` +
        `Later misses this session are counted in ${sentinel}, not logged.\n`,
    );
  } catch {
    // logging must never break a hook
  }
};

// The field NAMES the runtime sent, never their values. This one string is what two
// audits lacked: both reasoned about the payload's shape from this file's comments, both
// were wrong, and settling it took wiring a throwaway probe and running a session. The
// shape is a runtime contract that has already changed once, so the next time identity
// breaks the log says which keys actually arrived, and nobody has to guess a third time.
const payloadKeys = (payload) =>
  payload && typeof payload === "object"
    ? Object.keys(payload).sort().join(",")
    : "";

/**
 * The role the RUNTIME says just stopped, or "" when it does not say.
 *
 * The payload's own `agent_type` first, which every measured stop carried, then
 * `CLAUDE_AGENT_NAME` for a runtime that sets that instead (none seen so far, kept
 * because it costs one `||` and the alternative is another audit spent finding out).
 *
 * Bare or namespaced, never suffixed with a ticket. `createHookContext` exposes the same
 * two as `ctx.agentType` / `ctx.agentName`; they live here too so identity resolution has
 * them without every hook having to build a context first.
 *
 * @param {Record<string, unknown>} [payload]  Parsed SubagentStop payload.
 */
export const runtimeAgentName = (payload) =>
  String(
    (payload && (payload.agent_type || payload.agent_name)) ||
      process.env.CLAUDE_AGENT_NAME ||
      "",
  ).trim();

// The runtime named the agent, so any guess that disagrees is wrong by definition.
// Three outcomes:
//   - the guess agrees          keep it whole (description, transcript, ticket).
//   - nothing was guessed       the role alone, which is enough for every role gate.
//   - the guess CONTRADICTS it  the role alone, and the guess's transcript is dropped
//                               rather than trusted: it belongs to another agent, and
//                               reading a `MODE:` line or a verdict out of it is the
//                               exact bug this strategy exists to end.
// Do two identity strings name the same ROLE? Not string equality: the runtime and the
// spawn meta disagree on shape all the time, one saying `developer` where the other says
// `aiharness:developer` or the suffixed `developer-TASK-001`. Comparing them raw made a
// suffixed name contradict its own meta, which threw away the transcript that carried the
// ticket. Asked both ways, because either side can be the one carrying the suffix.
// `simple-developer` and `developer` still do not match: the role regex is anchored.
const sameRole = (a, b) =>
  matchesRole(a, new Set([bareRole(b)])) ||
  matchesRole(b, new Set([bareRole(a)]));

const withRuntimeName = (guess, payload) => {
  const name = runtimeAgentName(payload);
  if (!name) return guess;
  if (guess && sameRole(guess.agentType, name)) return guess;
  if (guess) noteContradiction(payload, name, guess);
  return {
    agentType: name,
    description: "",
    // Which of the two named it, so a log line says whether the payload field is
    // carrying this runtime or whether it fell back to the environment.
    source:
      payload && (payload.agent_type || payload.agent_name)
        ? "payload-type"
        : "runtime-env",
    transcriptPath: "",
    metaPath: "",
  };
};

// One line per session when the runtime name and the guess name different roles. The
// count is what makes the next run's log answer "is the guess still being used, and how
// often is it wrong" without re-reading a full transcript tree.
let notedThisProcess = false;
const noteContradiction = (payload, name, guess) => {
  if (notedThisProcess) return;
  notedThisProcess = true;
  const dir = sessionDirOf(payload);
  const sentinel = join(dir, "identity-contradicted");
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
  if (seen > 0) return;
  try {
    appendFileSync(
      join(dir, "hooks.log"),
      `[${new Date().toISOString()}] [agent-meta] WARN identity-contradicted ` +
        `runtime=${name} guessed=${guess.agentType} via=${guess.source} ` +
        `payload_keys=[${payloadKeys(payload)}]: ` +
        `the runtime name wins and the guessed transcript is dropped. ` +
        `Later disagreements this session are counted in ${sentinel}, not logged.\n`,
    );
  } catch {
    // logging must never break a hook
  }
};

// One payload per hook process, and strategy 4 reads every subagent transcript in the
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
 *
 *   `source` is "runtime-env" when CLAUDE_AGENT_NAME answered and no meta agreed with
 *   it: `description` and `transcriptPath` are then EMPTY on purpose, because the only
 *   candidates on disk belonged to another agent.
 */
export function readAgentMeta(payload) {
  if (payload && typeof payload === "object" && memo.has(payload))
    return memo.get(payload);
  const hit = withRuntimeName(
    byAgentId(payload) || bySiblingMeta(payload) || byNewestDispatch(payload),
    payload,
  );
  if (!hit && !isPhantomStop(payload)) warnUnresolvable(payload);
  if (payload && typeof payload === "object") memo.set(payload, hit);
  return hit;
}

/**
 * The DISPATCH PROMPT the stopping agent was given, or "" when it cannot be resolved.
 *
 * The first user event of its own transcript, and nothing else. Callers looking for a
 * dispatch-contract line (`MODE:`, `ROLE:`, `TASK_ID:`) want exactly this and not the
 * whole file: an agent's transcript also holds every prompt it WROTE for the agents it
 * dispatched, so scanning it whole makes a dispatcher answer for its dispatchees.
 *
 * @param {Record<string, unknown>} payload  Parsed SubagentStop payload.
 * @returns {string}
 */
export function dispatchPrompt(payload) {
  const tp = agentTranscriptPath(payload);
  return tp && existsSync(tp) ? firstUserText(tp) : "";
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
