#!/usr/bin/env node
// Archived transcripts in, one SQLite store out.
//
// Reads the archive scripts/run-archive.mjs produced (or, with --live, the transcripts
// still sitting in ~/.claude/projects) and writes runs / agents / turns / calls /
// activities / loops / hooks.
//
// Re-running is the normal case, not the exceptional one: the derivation in
// scripts/lib/run-model.mjs will keep improving, and every improvement is only worth
// having if it applies to the runs already captured. `--all` over the archive rebuilds the
// whole history under the current logic in one pass.
//
// Usage:
//   node scripts/run-ingest.mjs --all [--db <file>] [--archive <dir>]
//   node scripts/run-ingest.mjs --session <id> [--slug <slug>] [--arm A] [--label "..."]
//   node scripts/run-ingest.mjs --latest  [--slug <slug>] [--arm A] [--label "..."]
//   node scripts/run-ingest.mjs --live --session <id> --slug <slug>
//   node scripts/run-ingest.mjs --status
//
// --whole counts every session whole, as if it had dispatched no harness agent.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CONFIG_DIR, REPO } from "../hooks/lib/paths.mjs";
import { makeClassifier, validateCommandsFrom } from "./lib/activity.mjs";
import { buildRun, SCHEMA_VERSION } from "./lib/run-model.mjs";
import { ingestedRuns, openStore, writeRun } from "./lib/run-store.mjs";
import { latestSession, projectSlug } from "./lib/stat-target.mjs";
import { subagentsIn } from "./lib/transcripts.mjs";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : fallback;
};

const ARCHIVE =
  value("archive") ||
  process.env.HARNESS_RUNS_DIR ||
  join(REPO, ".runs", "archive");
const DB = value("db") || join(REPO, ".runs", "runs.sqlite");

const readIf = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

function harnessConfig() {
  for (const candidate of [
    value("config"),
    join(process.cwd(), "harness.config.json"),
    join(REPO, "harness.config.json"),
  ]) {
    if (candidate && existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8"));
      } catch {
        /* a malformed config must not stop an ingest: the generic rules still apply */
      }
    }
  }
  return null;
}

// The roles that open a run window: those the project's config declares, plus every agent
// this plugin ships, so a project whose config predates a role still recognises it.
function harnessRoles(config) {
  const roles = new Set(Object.keys(config?.roles || {}));
  const shipped = join(dirname(fileURLToPath(import.meta.url)), "..", "agents");
  for (const file of existsSync(shipped) ? readdirSync(shipped) : [])
    if (file.endsWith(".md")) roles.add(basename(file, ".md"));
  return roles;
}

/** Every source this run can be built from, whether archived or still live. */
function sourcesFor({ live, slug, sessionId }) {
  if (live) {
    const dir = join(CONFIG_DIR, "projects", slug);
    return {
      sourcePath: dir,
      mainBody: readIf(join(dir, `${sessionId}.jsonl`)),
      agents: subagentsIn(join(dir, sessionId)),
      hooksLog: "",
    };
  }
  const dir = join(ARCHIVE, slug, sessionId);
  return {
    sourcePath: dir,
    mainBody: readIf(join(dir, "main.jsonl")),
    agents: subagentsIn(dir),
    hooksLog: readIf(join(dir, "hooks.log")),
  };
}

/** Every (slug, sessionId) pair in the archive. */
function archivedSessions() {
  if (!existsSync(ARCHIVE)) return [];
  const out = [];
  for (const slug of readdirSync(ARCHIVE, { withFileTypes: true })) {
    if (!slug.isDirectory()) continue;
    const slugDir = join(ARCHIVE, slug.name);
    for (const session of readdirSync(slugDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      out.push({ slug: slug.name, sessionId: session.name });
    }
  }
  return out;
}

if (flag("status")) {
  if (!existsSync(DB)) {
    console.error(`no store at ${DB}`);
    process.exit(1);
  }
  const db = openStore(DB);
  const rows = ingestedRuns(db);
  const stale = rows.filter((r) => r.schema_version !== SCHEMA_VERSION);
  console.log(`store ${DB}`);
  console.log(`${rows.length} runs, schema ${SCHEMA_VERSION}`);
  if (stale.length)
    console.log(
      `${stale.length} derived under an older schema: re-run with --all to bring them up`,
    );
  process.exit(0);
}

const config = harnessConfig();
const classify = makeClassifier({
  validateCommands: validateCommandsFrom(config),
});
const roles = harnessRoles(config);

let targets;
if (flag("all")) {
  targets = archivedSessions();
} else if (flag("latest")) {
  // Tagging an A/B arm means naming the run that just finished, and its id is nowhere a
  // person can see it. The newest transcript for the slug IS that run, which is the same
  // rule /stat uses to pick a session.
  const slug = value("slug") || projectSlug(REPO);
  const sessionId = latestSession(join(CONFIG_DIR, "projects", slug));
  if (!sessionId) {
    console.error(`no session found under ${slug}`);
    process.exit(1);
  }
  console.log(`latest session for ${slug}: ${sessionId}`);
  targets = [{ slug, sessionId }];
} else {
  const sessionId = value("session");
  if (!sessionId) {
    console.error(
      "usage: run-ingest.mjs --all | --latest | --session <id> [--slug <slug>] [--live]\n" +
        "       run-ingest.mjs --status",
    );
    process.exit(1);
  }
  let slug = value("slug");
  if (!slug) {
    const hit = archivedSessions().find((s) => s.sessionId === sessionId);
    slug = hit?.slug || REPO.replace(/\//g, "-");
  }
  targets = [{ slug, sessionId }];
}

if (!targets.length) {
  console.error(
    `nothing to ingest under ${ARCHIVE} (run scripts/run-archive.mjs first)`,
  );
  process.exit(1);
}

const db = openStore(DB);
const live = flag("live");
let ok = 0;
let empty = 0;

for (const { slug, sessionId } of targets) {
  const src = sourcesFor({ live, slug, sessionId });
  if (!src.mainBody.trim() && !src.agents.length) {
    empty++;
    continue;
  }
  const run = buildRun({
    sessionId,
    slug,
    mainBody: src.mainBody,
    agents: src.agents,
    hooksLog: src.hooksLog,
    classify,
    harnessRoles: roles,
    whole: flag("whole"),
    tags: {
      arm: value("arm"),
      label: value("label"),
      harnessVersion: value("harness-version"),
      sourcePath: src.sourcePath,
    },
  });
  const wrote = writeRun(db, run);
  ok++;
  const mins = run.durationMs ? (run.durationMs / 60000).toFixed(0) : "?";
  console.log(
    `${sessionId.slice(0, 8)}  ${String(wrote.agents).padStart(3)} agents  ` +
      `${String(wrote.turns).padStart(4)} turns  ${String(wrote.calls).padStart(5)} calls  ` +
      `${String(mins).padStart(4)}min  $${run.usd.toFixed(2)}` +
      `${run.hasHooksLog ? "" : "  (no hooks.log)"}`,
  );
}

console.log(
  `\ningested ${ok} runs into ${DB}${empty ? `, skipped ${empty} empty` : ""}`,
);
if (!flag("live"))
  console.log(
    `re-derive everything after a run-model change with:\n  node scripts/run-ingest.mjs --all`,
  );
