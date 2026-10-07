// Which session `run-stats.mjs` reports when nobody names one.

import { readdirSync, statSync } from "node:fs";
import { basename, join } from "node:path";

/**
 * The directory name Claude Code keeps a project's transcripts under: its path with every
 * character that is not a letter or a digit turned into `-`.
 * @param {string} repo absolute project path
 * @returns {string}
 */
export const projectSlug = (repo) => String(repo).replace(/[^A-Za-z0-9]/g, "-");

/**
 * The session whose main transcript was written last, or null when there is none. Last
 * written, not last started: a session resumed today outranks one opened an hour ago.
 * @param {string} projectDir ~/.claude/projects/<slug>
 * @returns {string | null}
 */
export function latestSession(projectDir) {
  let entries;
  try {
    entries = readdirSync(projectDir);
  } catch {
    return null;
  }
  let best = null;
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const mtime = statSync(join(projectDir, name)).mtimeMs;
    if (!best || mtime > best.mtime)
      best = { id: basename(name, ".jsonl"), mtime };
  }
  return best ? best.id : null;
}
