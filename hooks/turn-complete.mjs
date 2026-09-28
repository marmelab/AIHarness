#!/usr/bin/env node
// Stop: drop a per-session sentinel file so a managed launcher (e.g. CRM
// Builder's chat-service PtySession) knows the turn is complete. Stop fires after
// the JSONL transcript is fully written, so the watcher can emit its result event
// only once the transcript is flushed.
//
// The sentinel directory is a launcher extension point: config.launcher
// .turnSentinelDir (see rules/launcher-interface.md). When it is unset (no managed
// launcher, which is the default) this hook is INERT: no directory is created, no path
// is hardcoded. A launcher-backed project sets it, e.g. /tmp/pty-sentinels — see
// adapters/launcher-chat-service/.

import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, launcher } from "./lib/config.mjs";
import { REPO } from "./lib/paths.mjs";
import { preserveHooksLog } from "./lib/hooks-log.mjs";

let sid = "";
try {
  sid = JSON.parse(readFileSync(0, "utf8")).session_id || "";
} catch {
  // no session id -> nothing to signal
}

// Mirror hooks.log beside the session's transcripts. SessionEnd takes the complete copy,
// but it only fires on a clean end — `clear`, `resume`, `logout`, `prompt_input_exit`,
// `other` — and promises nothing about a crash or a closed terminal. This one runs after
// every turn, so a killed session still leaves its guard log behind, one turn stale.
// Skipped when the file has not grown, which is most turns.
preserveHooksLog(REPO, sid);

let dir = null;
try {
  dir = launcher(loadConfig()).turnSentinelDir || null;
} catch {
  dir = null; // fail-open: a config error must never break the Stop hook
}

if (sid && dir) {
  mkdirSync(dir, { recursive: true });
  closeSync(openSync(join(dir, `pty-turn-done-${sid}`), "w"));
}
