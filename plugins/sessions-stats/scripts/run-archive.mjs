#!/usr/bin/env node
// Copy Claude Code's transcripts out of the directory that deletes them.
//
// Claude Code prunes ~/.claude/projects after `cleanupPeriodDays` (30 by default). Those
// transcripts are the only record of how a run actually went, and they are the input every
// later indicator is derived from, including the ones nobody has thought of yet. Losing
// them is losing the harness's own history.
//
// So the archive keeps the RAW files, never a digest: scripts/run-ingest.mjs re-derives
// the store from them whenever the derivation improves, and an archived run stays
// comparable with a run captured a year later.
//
// A harness session's hooks.log is mirrored into the session's sidecar directory by the
// harness itself, so it is archived with the rest of that directory. A session older than
// that mirror has only the live copy under $HARNESS_TMP_ROOT (/tmp by default), which a
// reboot sweeps; it is taken while it survives. Its absence is recorded, because "no hook
// ever fired" and "the log was swept" are very different readings of the same empty set.
//
// Usage:
//   node scripts/run-archive.mjs --list
//   node scripts/run-archive.mjs --slug <project-slug> [--dest <dir>] [--force]
//   node scripts/run-archive.mjs --all [--dest <dir>]

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { CONFIG_DIR, REPO } from "./lib/paths.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
};

const PROJECTS = join(CONFIG_DIR, "projects");
const DEST = value(
  "dest",
  process.env.SESSIONS_STATS_ARCHIVE || join(REPO, ".runs", "archive"),
);
// The harness's own tmp root, read only to recover a hooks.log it has not mirrored.
const HARNESS_TMP_ROOT = process.env.HARNESS_TMP_ROOT || "/tmp";

const listSlugs = () =>
  existsSync(PROJECTS)
    ? readdirSync(PROJECTS, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    : [];

/** The sessions of one slug: a transcript file, plus its sidecar directory when present. */
function sessionsOf(slug) {
  const dir = join(PROJECTS, slug);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".jsonl")) continue;
    const id = basename(entry, ".jsonl");
    const main = join(dir, entry);
    const side = join(dir, id);
    out.push({
      id,
      slug,
      main,
      side: existsSync(side) ? side : null,
      bytes: statSync(main).size,
      mtime: statSync(main).mtimeMs,
    });
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function copyTree(from, to) {
  let files = 0;
  let bytes = 0;
  mkdirSync(to, { recursive: true });
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name);
    const dst = join(to, entry.name);
    if (entry.isDirectory()) {
      const sub = copyTree(src, dst);
      files += sub.files;
      bytes += sub.bytes;
      continue;
    }
    if (!entry.isFile()) continue;
    copyFileSync(src, dst);
    files++;
    bytes += statSync(dst).size;
  }
  return { files, bytes };
}

/**
 * Where the harness wrote this session's hooks.log, if it still exists: the harness's
 * session directory under its tmp root, `<root>/<sanitized repo>/<session id>/`.
 *
 * The repo root is NOT recoverable from the transcript slug: both encode the path with a
 * separator substitution, and `-` is legal in a directory name, so
 * `-workspaces-popimpact-root-popimpact` has more than one pre-image. Scanning for the
 * session id instead is exact, since it is a uuid.
 */
function liveHooksLogFor(sessionId) {
  if (!existsSync(HARNESS_TMP_ROOT)) return null;
  for (const entry of readdirSync(HARNESS_TMP_ROOT, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = join(
      HARNESS_TMP_ROOT,
      entry.name,
      sessionId,
      "hooks.log",
    );
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function archive(session, { force }) {
  const dest = join(DEST, session.slug, session.id);
  const manifestPath = join(dest, "manifest.json");
  if (existsSync(manifestPath) && !force) {
    const prev = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (prev.mainBytes === session.bytes) return { ...prev, skipped: true };
  }
  mkdirSync(dest, { recursive: true });
  copyFileSync(session.main, join(dest, "main.jsonl"));
  let side = { files: 0, bytes: 0 };
  if (session.side) side = copyTree(session.side, dest);

  // The mirror in the sidecar directory came with it; a session older than the mirror
  // only has the live copy, while it survives.
  let hooks = existsSync(join(dest, "hooks.log"));
  if (!hooks) {
    const live = liveHooksLogFor(session.id);
    if (live) copyFileSync(live, join(dest, "hooks.log"));
    hooks = Boolean(live);
  }

  const manifest = {
    sessionId: session.id,
    slug: session.slug,
    archivedAt: new Date().toISOString(),
    mainBytes: session.bytes,
    sidecarFiles: side.files,
    sidecarBytes: side.bytes,
    // Recorded as a fact, not inferred later from an empty hooks table: a swept log and a
    // session where no hook ran are indistinguishable once the file is gone.
    hooksLog: hooks ? "archived" : "absent-at-archive-time",
    sourceMain: session.main,
    sourceSidecar: session.side,
  };
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, skipped: false };
}

const human = (b) =>
  b > 1e6
    ? `${(b / 1e6).toFixed(1)}MB`
    : b > 1e3
      ? `${Math.round(b / 1e3)}KB`
      : `${b}B`;

if (flag("list") || (!flag("all") && !value("slug"))) {
  const slugs = listSlugs();
  if (!slugs.length) {
    console.error(`no project transcripts under ${PROJECTS}`);
    process.exit(1);
  }
  console.log(`transcripts under ${PROJECTS}\n`);
  console.log("sessions  subagents  size      slug");
  for (const slug of slugs) {
    const sessions = sessionsOf(slug);
    if (!sessions.length) continue;
    const subs = sessions.filter((s) => s.side).length;
    const bytes = sessions.reduce((sum, s) => sum + s.bytes, 0);
    console.log(
      `${String(sessions.length).padStart(8)}  ${String(subs).padStart(9)}  ` +
        `${human(bytes).padStart(8)}  ${slug}`,
    );
  }
  console.log(`\narchive one with: node scripts/run-archive.mjs --slug <slug>`);
  console.log(`destination: ${DEST}`);
  process.exit(0);
}

const slugs = flag("all") ? listSlugs() : [value("slug")];
const force = flag("force");
let archived = 0;
let skipped = 0;
let bytes = 0;
let noHooks = 0;

for (const slug of slugs) {
  const sessions = sessionsOf(slug);
  if (!sessions.length) continue;
  for (const session of sessions) {
    const res = archive(session, { force });
    if (res.skipped) {
      skipped++;
      continue;
    }
    archived++;
    bytes += res.mainBytes + res.sidecarBytes;
    if (res.hooksLog !== "archived") noHooks++;
  }
  console.log(`${slug}: ${sessions.length} sessions`);
}

console.log(
  `\narchived ${archived}, already current ${skipped}, ${human(bytes)} into ${DEST}`,
);
if (noHooks)
  console.log(
    `${noHooks} of them had no hooks.log beside their transcripts or under ` +
      `${HARNESS_TMP_ROOT} (a session without the harness, or a log swept on reboot);\n` +
      `their guard activity is unrecoverable and the manifests record that.`,
  );
