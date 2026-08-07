// The runtime's per-session scratchpad directory, the one place an agent may write
// throwaway files: /tmp/claude-<uid>/<project>/<session_id>/scratchpad.
//
// No environment variable carries it into a hook, so it is resolved from the single
// part a hook payload knows (the session id) by scanning the /tmp/claude-<uid>
// roots. Resolution is best-effort: a guard that needs to RECOGNISE a scratchpad
// target must not depend on the directory already existing, so isScratchpadTarget
// falls back to the path shape.

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT_RE = /^claude-\d+$/;

/**
 * The absolute scratchpad directory for `sessionId`, or "" when none exists.
 * @param {string} sessionId
 * @param {string} [tmp] tmp root holding the claude-<uid> directories
 * @returns {string}
 */
export function scratchpadDir(sessionId, tmp = "/tmp") {
  if (!sessionId) return "";
  let roots;
  try {
    roots = readdirSync(tmp).filter((d) => ROOT_RE.test(d));
  } catch {
    return "";
  }
  for (const root of roots) {
    let projects;
    try {
      projects = readdirSync(join(tmp, root));
    } catch {
      continue;
    }
    for (const project of projects) {
      const candidate = join(tmp, root, project, sessionId, "scratchpad");
      if (existsSync(candidate)) return candidate;
    }
  }
  return "";
}

/**
 * Does `target` live in THIS session's scratchpad? True for a path under the
 * resolved directory, and for anything carrying the `<session_id>/scratchpad/`
 * shape, so the answer holds before the directory is first written to.
 * @param {string} target
 * @param {string} sessionId
 * @param {string} [tmp]
 * @returns {boolean}
 */
export function isScratchpadTarget(target, sessionId, tmp = "/tmp") {
  if (!target || !sessionId) return false;
  const dir = scratchpadDir(sessionId, tmp);
  if (dir && target.startsWith(`${dir}/`)) return true;
  return target.includes(`/${sessionId}/scratchpad/`);
}
