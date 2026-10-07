// Which sessions `run-stats.mjs` reports: the one named, the project's last written, or
// the latest of every project.

import { readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
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

/**
 * The project directory holding a session's transcript, or null. A session id is a uuid,
 * so the first hit is the only one.
 * @param {string} projectsDir ~/.claude/projects
 * @param {string} sessionId
 * @returns {string | null} the slug
 */
export function slugOf(projectsDir, sessionId) {
  let slugs;
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const slug of slugs) {
    try {
      statSync(join(projectsDir, slug, `${sessionId}.jsonl`));
      return slug;
    } catch {
      /* not this project */
    }
  }
  return null;
}

/**
 * Every session of every project, the last written first.
 *
 * Projects under the system tmp dir are left out unless `project` names them: they are
 * test fixtures and throwaway probes, one session each, and in a plain list they bury the
 * sessions someone actually worked in.
 *
 * @param {string} projectsDir ~/.claude/projects
 * @param {{sinceMs?: number | null, project?: string | null, now?: number}} [filter]
 *   `sinceMs`: only sessions written within that many milliseconds;
 *   `project`: only projects whose slug contains that text, case-insensitively
 * @returns {{slug: string, id: string, mtime: number}[]}
 */
export function recentSessions(
  projectsDir,
  { sinceMs = null, project = null, now = Date.now() } = {},
) {
  let slugs;
  try {
    slugs = readdirSync(projectsDir);
  } catch {
    return [];
  }
  const wanted = project ? String(project).toLowerCase() : null;
  const tmpSlugs = [...new Set([projectSlug("/tmp"), projectSlug(tmpdir())])];
  const isTmp = (slug) =>
    tmpSlugs.some((t) => slug === t || slug.startsWith(`${t}-`));
  const out = [];
  for (const slug of slugs) {
    if (wanted ? !slug.toLowerCase().includes(wanted) : isTmp(slug)) continue;
    let names;
    try {
      names = readdirSync(join(projectsDir, slug));
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const mtime = statSync(join(projectsDir, slug, name)).mtimeMs;
      if (sinceMs != null && now - mtime > sinceMs) continue;
      out.push({ slug, id: basename(name, ".jsonl"), mtime });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

const AGE_UNITS = { m: 60e3, h: 3600e3, d: 86400e3, w: 7 * 86400e3 };

/**
 * `30m`, `12h`, `3d`, `2w` in milliseconds; null for anything else.
 * @param {string | null} text
 * @returns {number | null}
 */
export function parseAge(text) {
  const m = /^(\d+)([mhdw])$/.exec(String(text ?? "").trim());
  return m ? Number(m[1]) * AGE_UNITS[m[2]] : null;
}
