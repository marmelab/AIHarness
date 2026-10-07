#!/usr/bin/env node
// One session's run-anatomy page in one step: ingest it live, render it, open it.
//
// The session gets a store of its own under the tmp root, so a run still in progress
// never lands in the archive's store, and the page shows that session and nothing else.
//
// Without --session it takes the session of the current project that wrote last, which is
// the current one when run from inside it. The /stat command passes its session exactly;
// a keyboard shortcut cannot, and when two sessions of one project run at once it takes
// the one that wrote last.
//
// Opening: under a VS Code remote (devcontainer, SSH) $BROWSER hands a URL to the host's
// browser, where a container path means nothing. So the page is served on localhost by a
// detached child that VS Code forwards, which stops after its first visit or ten minutes.
// Elsewhere the file itself is opened.
//
// Usage:
//   node scripts/run-stats.mjs [--session <id>] [--whole] [--no-open]

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CONFIG_DIR, REPO, TMP_ROOT } from "./lib/paths.mjs";
import { latestSession, projectSlug } from "./lib/stat-target.mjs";

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

if (value("serve")) serve(value("serve"));
else main();

function main() {
  const slug = projectSlug(REPO);
  const projectDir = join(CONFIG_DIR, "projects", slug);
  const sessionId = value("session") || latestSession(projectDir);
  if (!sessionId) {
    console.error(`stat: no session transcript under ${projectDir}`);
    process.exit(1);
  }

  const out = TMP_ROOT;
  const short = sessionId.slice(0, 8);
  const db = join(out, `${short}.sqlite`);
  const page = join(out, `${short}.html`);

  const ingest = run("run-ingest.mjs", [
    "--live",
    "--session",
    sessionId,
    "--slug",
    slug,
    "--db",
    db,
    ...(flag("whole") ? ["--whole"] : []),
  ]);
  const summary = ingest.split("\n").find((l) => l.startsWith(short));
  // A session's first prompt has no model turn yet, so there is nothing to chart: say that,
  // rather than the report's "run the ingest first", which is advice for the archive.
  if (!summary || /\s0 turns/.test(summary)) {
    console.error(
      `stat: session ${short} has no model turn yet, nothing to chart`,
    );
    process.exit(1);
  }
  run("run-report.mjs", ["--db", db, "--sessions", sessionId, "--out", page]);

  if (summary) console.log(summary.trim());
  if (flag("no-open")) {
    console.log(`page: ${page}`);
    return;
  }
  open(page);
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
