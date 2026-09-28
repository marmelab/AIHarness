// Keeping hooks.log alive.
//
// The file is written into the session directory, which is also `worktreeBase`, which
// cleanup-session deletes whole when the session ends. So the log of what the guards did
// was destroyed by the harness itself on every session, and an archive of 78 real sessions
// held not one line of it.
//
// That matters more than it sounds. A transcript records PreToolUse, PostToolUse, Stop and
// SessionStart executions with exact durations, and never a SubagentStop — which is the
// event the validation chain runs on. hooks.log is the only place a typecheck, a lint or a
// test suite running on a developer's stop leaves any trace at all, and every line carries
// its own timestamp, so the chain can be timed from it exactly.
//
// The copy lands beside that session's transcripts: same session id, same retention as the
// rest of the run's record, and already collected by anything that archives a session.
//
// It is mirrored at TWO moments, because neither alone is enough:
//
//   - on SessionEnd, just before the directory goes. This is the complete copy, but
//     SessionEnd fires on `clear`, `resume`, `logout`, `prompt_input_exit` and `other`, and
//     the documentation promises nothing about a crash, a SIGKILL or a closed terminal.
//   - on Stop, after every turn. This one is at most a turn stale and survives a kill.
//
// Copying is never allowed to be the reason a hook fails: every path here swallows.

import { copyFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR, TMP_ROOT, sanitizePath } from "./paths.mjs";

/**
 * Claude Code's sidecar directory for one session: where its subagent transcripts and tool
 * results already live, keyed on the same session id.
 *
 * The slug is the project root with its separators replaced by `-`, which is how Claude
 * Code names these directories. Note this is NOT `sanitizePath`, which the harness uses for
 * its own tmp namespace with a different character.
 *
 * @param {string} repo
 * @param {string} sessionId
 * @returns {string}
 */
export function transcriptDir(repo, sessionId) {
  return join(
    CONFIG_DIR,
    "projects",
    String(repo).replace(/\//g, "-"),
    String(sessionId),
  );
}

/**
 * Where the harness writes the log during a session.
 *
 * @param {string} repo
 * @param {string} sessionId
 * @returns {string}
 */
export function liveHooksLog(repo, sessionId) {
  return join(TMP_ROOT, sanitizePath(repo), String(sessionId), "hooks.log");
}

/**
 * Copy the session's hooks.log beside its transcripts.
 *
 * Skips silently when there is nothing to copy, and when the destination is already the
 * same size: Stop fires on every turn and most turns add no line at all.
 *
 * @param {string} repo
 * @param {string} sessionId
 * @returns {boolean} whether a copy was made
 */
export function preserveHooksLog(repo, sessionId) {
  if (!repo || !sessionId) return false;
  try {
    const from = liveHooksLog(repo, sessionId);
    if (!existsSync(from)) return false;
    const to = join(transcriptDir(repo, sessionId), "hooks.log");
    if (existsSync(to) && statSync(to).size === statSync(from).size)
      return false;
    mkdirSync(transcriptDir(repo, sessionId), { recursive: true });
    copyFileSync(from, to);
    return true;
  } catch {
    // Preserving the log must never be the reason a hook fails.
    return false;
  }
}
