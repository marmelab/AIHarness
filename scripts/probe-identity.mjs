#!/usr/bin/env node
// Diagnostic, not a registered hook. Answers one question that two audits have now
// guessed at and got wrong: WHAT does the runtime actually put in a SubagentStop payload,
// and in the hook's environment, that names the agent that stopped?
//
// The record so far. Run 2151445b: two hooks disagreed 13ms apart on the same stop, which
// was read as "one reads CLAUDE_AGENT_NAME, the other guesses". Run 883fa33f disproved
// that: 57 of 57 resolutions came from the newest-dispatch mtime guess, 10 stops resolved
// to nothing at all, and no runtime-env resolution ever happened. Both hooks had been
// guessing, and the mtime ordering simply changed between the two calls.
//
// So stop inferring. Wire this on SubagentStop, run one session, read the file:
//
//   "hooks": {
//     "SubagentStop": [
//       { "hooks": [{ "type": "command",
//                     "command": "node /path/to/AIHarness/scripts/probe-identity.mjs" }] }
//     ]
//   }
//
// It writes one JSON line per stop to $IDENTITY_PROBE_OUT (default
// ~/.claude/identity-probe.jsonl), never blocks, and never throws: a diagnostic that can
// wedge a session would not survive contact with a real run.
//
// Values are truncated, not hashed: the point is to SEE which field carries an agent id,
// so a path or an id has to stay readable. Do not leave it wired on a shared machine.

import { appendFileSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const OUT =
  process.env.IDENTITY_PROBE_OUT ||
  join(homedir(), ".claude", "identity-probe.jsonl");
const CAP = 220;

const brief = (v) => {
  if (v === null || v === undefined) return v;
  if (typeof v === "string")
    return v.length > CAP ? `${v.slice(0, CAP)}…(${v.length})` : v;
  if (Array.isArray(v)) return `[array ${v.length}]`;
  if (typeof v === "object") return `{object keys=${Object.keys(v).join(",")}}`;
  return v;
};

try {
  const raw = readFileSync(0, "utf8");
  let payload = {};
  let parseError = "";
  try {
    payload = JSON.parse(raw);
  } catch (e) {
    parseError = String(e).slice(0, 120);
  }

  // Every top-level field, whatever it is called. The whole point is to find fields no
  // hook currently reads, so nothing is filtered by an expected-name list.
  const fields = {};
  for (const [k, v] of Object.entries(payload || {})) fields[k] = brief(v);

  // Everything the runtime exports that could name an agent or a session. Same rule:
  // enumerate, do not assume. CLAUDE_AGENT_NAME is listed explicitly so its ABSENCE is
  // recorded as an explicit null rather than as a missing key.
  const env = { CLAUDE_AGENT_NAME: process.env.CLAUDE_AGENT_NAME ?? null };
  for (const [k, v] of Object.entries(process.env)) {
    if (/^CLAUDE/.test(k) && !/KEY|TOKEN|SECRET/i.test(k)) env[k] = brief(v);
  }

  appendFileSync(
    OUT,
    JSON.stringify({
      at: new Date().toISOString(),
      pid: process.pid,
      event: payload?.hook_event_name ?? null,
      payloadKeys: Object.keys(payload || {}),
      fields,
      env,
      rawLength: raw.length,
      parseError,
    }) + "\n",
  );
} catch {
  // A diagnostic never breaks the thing it is diagnosing.
}
process.exit(0);
