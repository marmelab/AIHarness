#!/usr/bin/env node
// A stats page in one step: ingest the sessions live, render them, open the page.
//
// The sessions get a throwaway store under the tmp root, deleted once the page is written,
// so a run still in progress never lands in the archive's store and nothing accumulates:
// the page is all that is left, and pages older than a day are swept on the next run.
//
// Without --session it takes the session of the current project that wrote last, which is
// the current one when run from inside it. The /stat command passes its session exactly;
// a keyboard shortcut cannot, and when two sessions of one project run at once it takes
// the one that wrote last.
//
// --recent reports the latest sessions of EVERY project instead, the last written first:
// 25 by default, or `--last <n>`, or every session written within `--since <age>` (30m,
// 12h, 3d, 2w). `--project <text>` keeps the projects whose transcript directory contains
// that text. Any of the three implies --recent. A session that has no model turn yet does
// not count towards the 25.
//
// Opening: under a VS Code remote (devcontainer, SSH) $BROWSER hands a URL to the host's
// browser, where a container path means nothing. So the page is served on localhost by a
// detached child that VS Code forwards, which stops after its first visit or ten minutes.
// Elsewhere the file itself is opened.
//
// Usage:
//   node scripts/run-stats.mjs [--session <id>] [--whole] [--no-open]
//   node scripts/run-stats.mjs --recent [--last <n>] [--since <age>] [--project <text>]
//                              [--whole] [--no-open]

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG_DIR, REPO, TMP_ROOT } from "./lib/paths.mjs";
import {
  latestSession,
  parseAge,
  projectSlug,
  recentSessions,
  slugOf,
} from "./lib/stat-target.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--")
    ? args[i + 1]
    : null;
};

const SERVE_MS = 10 * 60 * 1000;
const GRACE_MS = 60 * 1000;
const PAGE_TTL_MS = 24 * 3600 * 1000;
const RECENT_DEFAULT = 25;
const PROJECTS = join(CONFIG_DIR, "projects");

if (value("serve")) serve(value("serve"));
else main();

function main() {
  sweep(TMP_ROOT);
  if (flag("recent") || value("last") || value("since") || value("project"))
    return recent();

  const here = projectSlug(REPO);
  const sessionId = value("session") || latestSession(join(PROJECTS, here));
  if (!sessionId) {
    console.error(`stat: no session transcript under ${join(PROJECTS, here)}`);
    process.exit(1);
  }
  // A named session is looked up by its id, which is exact: the project it ran in need not
  // be the one this script runs from.
  const slug = (value("session") && slugOf(PROJECTS, sessionId)) || here;

  const short = sessionId.slice(0, 8);
  const db = join(TMP_ROOT, `${short}.sqlite`);
  const page = join(TMP_ROOT, `${short}.html`);

  const summary = ingest(sessionId, slug, db, run);
  // A session's first prompt has no model turn yet, so there is nothing to chart: say that,
  // rather than the report's "run the ingest first", which is advice for the archive.
  if (!summary) {
    console.error(
      `stat: session ${short} has no model turn yet, nothing to chart`,
    );
    process.exit(1);
  }
  run("run-report.mjs", ["--db", db, "--sessions", sessionId, "--out", page]);
  drop(db);

  console.log(summary.trim());
  show(page);
}

function recent() {
  const since = value("since");
  const sinceMs = since == null ? null : parseAge(since);
  if (since != null && sinceMs == null) {
    console.error(`stat: --since takes an age such as 30m, 12h, 3d or 2w`);
    process.exit(1);
  }
  const last = value("last");
  const cap =
    last == null ? (sinceMs == null ? RECENT_DEFAULT : Infinity) : Number(last);
  if (!(cap > 0)) {
    console.error(`stat: --last takes a positive number`);
    process.exit(1);
  }

  const candidates = recentSessions(PROJECTS, {
    sinceMs,
    project: value("project"),
  });
  // Per process: two reports at once must not write into each other's store.
  const db = join(TMP_ROOT, `recent-${process.pid}.sqlite`);
  const page = join(TMP_ROOT, "recent.html");
  drop(db);

  const picked = [];
  for (const { slug, id } of candidates) {
    if (picked.length >= cap) break;
    // One unreadable transcript costs that session its place on the page, not the page.
    const summary = ingest(id, slug, db, tryRun);
    if (!summary) continue;
    picked.push(id);
    console.log(`${summary.trim()}  ${slug}`);
  }
  if (!picked.length) {
    console.error(`stat: no session with a model turn under ${PROJECTS}`);
    process.exit(1);
  }
  run("run-report.mjs", [
    "--db",
    db,
    "--sessions",
    picked.join(","),
    "--out",
    page,
  ]);
  drop(db);

  console.log(`${picked.length} sessions`);
  show(page);
}

/**
 * Ingests one live session into `db` and returns the ingest's summary line for it, or
 * null when the session has no model turn yet.
 */
function ingest(sessionId, slug, db, runner) {
  const out = runner("run-ingest.mjs", [
    "--live",
    "--session",
    sessionId,
    "--slug",
    slug,
    "--db",
    db,
    ...(flag("whole") ? ["--whole"] : []),
  ]);
  const summary = (out || "")
    .split("\n")
    .find((l) => l.startsWith(sessionId.slice(0, 8)));
  return summary && !/\s0 turns/.test(summary) ? summary : null;
}

function show(page) {
  if (flag("no-open")) console.log(`page: ${page}`);
  else open(page);
}

/** A store and the WAL files SQLite keeps beside it. */
function drop(db) {
  for (const file of [db, `${db}-wal`, `${db}-shm`])
    rmSync(file, { force: true });
}

/** Pages are only ever looked at once; a day later they are just disk. */
function sweep(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const now = Date.now();
  for (const name of names) {
    const file = join(dir, name);
    try {
      if (now - statSync(file).mtimeMs > PAGE_TTL_MS)
        rmSync(file, { force: true });
    } catch {
      /* gone already, or not ours to judge */
    }
  }
}

/** Runs a sibling script; its failure is this script's, reported with its own words. */
function run(script, scriptArgs) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...scriptArgs], {
    encoding: "utf8",
  });
  if (r.status !== 0) {
    process.stderr.write(r.stderr || r.stdout || `${script} failed\n`);
    process.exit(r.status || 1);
  }
  return r.stdout;
}

/** Runs a sibling script; its failure is reported and survived. */
function tryRun(script, scriptArgs) {
  const r = spawnSync(process.execPath, [join(HERE, script), ...scriptArgs], {
    encoding: "utf8",
  });
  if (r.status === 0) return r.stdout;
  process.stderr.write(r.stderr || r.stdout || `${script} failed\n`);
  return null;
}

function open(page) {
  if (!process.env.BROWSER) {
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    spawn(opener, [page], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
    console.log(`page: ${pathToFileURL(page)}`);
    return;
  }
  // The child prints its URL once listening, then nothing: reading that one line and
  // letting go is all this process waits for.
  const child = spawn(
    process.execPath,
    [fileURLToPath(import.meta.url), "--serve", page],
    {
      detached: true,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    if (!buffer.includes("\n")) return;
    console.log(`page: ${buffer.trim()}`);
    child.stdout.destroy();
    child.unref();
  });
}

function serve(page) {
  if (!existsSync(page)) process.exit(1);
  let visited = false;
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(readFileSync(page));
    if (!visited) {
      visited = true;
      setTimeout(() => process.exit(0), GRACE_MS).unref();
    }
  });
  server.listen(0, "127.0.0.1", () => {
    const url = `http://localhost:${server.address().port}/`;
    process.stdout.write(url + "\n");
    spawn(process.env.BROWSER, [url], { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  });
  setTimeout(() => process.exit(0), SERVE_MS).unref();
}
