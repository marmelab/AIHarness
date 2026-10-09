// Tests for run-stats.mjs: which sessions it picks, that it ends on a page or on a sentence
// saying why there is none, and that it leaves nothing behind but that page.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import {
  latestSession,
  parseAge,
  projectSlug,
  recentSessions,
  slugOf,
} from "../lib/stat-target.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "run-stats.mjs");

const turn = JSON.stringify({
  type: "assistant",
  timestamp: "2026-09-01T10:00:00.000Z",
  message: {
    id: "m1",
    model: "claude-sonnet-5",
    usage: { input_tokens: 10, output_tokens: 40 },
    content: [{ type: "text", text: "done" }],
  },
});
const prompt = JSON.stringify({
  type: "user",
  timestamp: "2026-09-01T09:59:59.000Z",
  message: { role: "user", content: "hello" },
});

let root;
afterEach(() => root && rmSync(root, { recursive: true, force: true }));

/** A config dir holding one project's transcripts, each written at the given second. */
function fixture(sessions) {
  root = mkdtempSync(join(tmpdir(), "run-stats-"));
  const repo = join(root, "repo");
  const projectDir = join(root, "config", "projects", projectSlug(repo));
  mkdirSync(projectDir, { recursive: true });
  for (const { id, body, second } of sessions) {
    const file = join(projectDir, `${id}.jsonl`);
    writeFileSync(file, body);
    utimesSync(file, second, second);
  }
  return { repo, projectDir };
}

const runStats = (repo, args) =>
  spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: repo,
      CLAUDE_CONFIG_DIR: join(root, "config"),
      SESSIONS_STATS_TMP_ROOT: join(root, "tmp"),
    },
  });

describe("projectSlug", () => {
  test("spells a path the way Claude Code names its transcript directory", () => {
    expect(projectSlug("/workspaces/AIHarness-root/AIHarness")).toBe(
      "-workspaces-AIHarness-root-AIHarness",
    );
    expect(projectSlug("/home/a.b/my_app")).toBe("-home-a-b-my-app");
  });
});

describe("latestSession", () => {
  test("is the transcript written last, not the one started last", () => {
    const { projectDir } = fixture([
      // the newest sorts in the middle by name, so only the write time can pick it
      { id: "aaaaaaaa-old", body: turn, second: 1000 },
      { id: "bbbbbbbb-new", body: turn, second: 3000 },
      { id: "cccccccc-mid", body: turn, second: 2000 },
    ]);
    writeFileSync(join(projectDir, "notes.txt"), "not a transcript");
    expect(latestSession(projectDir)).toBe("bbbbbbbb-new");
  });

  test("is null for a project with no transcript at all", () => {
    expect(latestSession(join(tmpdir(), "no-such-project-dir"))).toBe(null);
  });
});

describe("run-stats.mjs", () => {
  test("without --session, writes the page of the session written last", () => {
    const { repo } = fixture([
      { id: "aaaaaaaa-old", body: [prompt, turn].join("\n"), second: 1000 },
      { id: "bbbbbbbb-new", body: [prompt, turn].join("\n"), second: 3000 },
      { id: "cccccccc-mid", body: [prompt, turn].join("\n"), second: 2000 },
    ]);
    const r = runStats(repo, ["--no-open"]);
    expect(r.status).toBe(0);
    const page = join(root, "tmp", "sessions-stats", "bbbbbbbb.html");
    expect(r.stdout).toContain(`page: ${page}`);
    expect(existsSync(page)).toBe(true);
  });

  test("a session with no model turn yet says so instead of failing in the report", () => {
    const { repo } = fixture([
      { id: "cccccccc-fresh", body: prompt, second: 1000 },
    ]);
    const r = runStats(repo, ["--session", "cccccccc-fresh", "--no-open"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("has no model turn yet");
  });

  test("finds a named session in whichever project it ran", () => {
    projects({ "-work-elsewhere": [{ id: "cccccccc-x", second: 1000 }] });
    const r = runStats(join(root, "repo"), [
      "--session",
      "cccccccc-x",
      "--no-open",
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(join(root, "tmp", "sessions-stats"))).toEqual([
      "cccccccc.html",
    ]);
  });
});

/**
 * A config dir holding several projects' transcripts. `sessions` maps a slug to its
 * sessions, each written at the given second.
 */
function projects(sessions) {
  root = mkdtempSync(join(tmpdir(), "run-stats-"));
  const projectsDir = join(root, "config", "projects");
  for (const [slug, list] of Object.entries(sessions)) {
    mkdirSync(join(projectsDir, slug), { recursive: true });
    for (const { id, body = [prompt, turn].join("\n"), second } of list) {
      const file = join(projectsDir, slug, `${id}.jsonl`);
      writeFileSync(file, body);
      utimesSync(file, second, second);
    }
  }
  return projectsDir;
}

const NOW = 10_000_000_000;

describe("recentSessions", () => {
  test("lists every project's sessions, the last written first", () => {
    const dir = projects({
      "-work-alpha": [{ id: "a-old", second: 1000 }],
      "-work-beta": [
        { id: "b-new", second: 3000 },
        { id: "b-mid", second: 2000 },
      ],
    });
    expect(recentSessions(dir).map((s) => s.id)).toEqual([
      "b-new",
      "b-mid",
      "a-old",
    ]);
  });

  test("leaves out projects under a tmp dir unless they are named", () => {
    const dir = projects({
      "-work-alpha": [{ id: "real", second: 1000 }],
      "-tmp-probe-x": [{ id: "probe", second: 2000 }],
      [projectSlug(join(tmpdir(), "fixture"))]: [
        { id: "fixture", second: 3000 },
      ],
    });
    expect(recentSessions(dir).map((s) => s.id)).toEqual(["real"]);
    expect(recentSessions(dir, { project: "PROBE" }).map((s) => s.id)).toEqual([
      "probe",
    ]);
  });

  test("keeps only what was written within `sinceMs`", () => {
    const dir = projects({
      "-work-alpha": [
        { id: "fresh", second: NOW / 1000 - 60 },
        { id: "stale", second: NOW / 1000 - 7200 },
      ],
    });
    const ids = recentSessions(dir, { sinceMs: 3600e3, now: NOW }).map(
      (s) => s.id,
    );
    expect(ids).toEqual(["fresh"]);
  });

  test("is empty when there is no projects directory", () => {
    expect(recentSessions(join(tmpdir(), "no-such-projects-dir"))).toEqual([]);
  });
});

describe("slugOf", () => {
  test("finds the project a session ran in from its id alone", () => {
    const dir = projects({
      "-work-alpha": [{ id: "a1", second: 1000 }],
      "-work-beta": [{ id: "b1", second: 1000 }],
    });
    expect(slugOf(dir, "b1")).toBe("-work-beta");
    expect(slugOf(dir, "zz")).toBe(null);
  });
});

describe("parseAge", () => {
  test("reads minutes, hours, days and weeks, and nothing else", () => {
    expect(parseAge("30m")).toBe(30 * 60e3);
    expect(parseAge("12h")).toBe(12 * 3600e3);
    expect(parseAge("3d")).toBe(3 * 86400e3);
    expect(parseAge("2w")).toBe(14 * 86400e3);
    for (const bad of ["3", "d", "3 days", "-1d", "", null])
      expect(parseAge(bad)).toBe(null);
  });
});

const stats = (args) => runStats(join(root, "repo"), args);
const pageOf = (r) => /^page: (.+)$/m.exec(r.stdout)?.[1];
/** The session ids a page was built from. */
const pickedOn = (r) =>
  JSON.parse(/"picked":(\[[^\]]*\])/.exec(readFileSync(pageOf(r), "utf8"))[1]);

describe("run-stats.mjs --recent", () => {
  test("puts the latest sessions of every project on one page, newest first", () => {
    projects({
      "-work-alpha": [
        { id: "aaaaaaaa-1", second: 1000 },
        { id: "aaaaaaaa-3", second: 3000 },
      ],
      "-work-beta": [{ id: "bbbbbbbb-2", second: 2000 }],
    });
    const r = stats(["--recent", "--last", "2", "--no-open"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("2 sessions");
    expect(pickedOn(r)).toEqual(["aaaaaaaa-3", "bbbbbbbb-2"]);
  });

  test("a session with no model turn yet does not take a place", () => {
    projects({
      "-work-alpha": [
        { id: "aaaaaaaa-fresh", body: prompt, second: 3000 },
        { id: "aaaaaaaa-done", second: 2000 },
        { id: "aaaaaaaa-older", second: 1000 },
      ],
    });
    const r = stats(["--last", "1", "--no-open"]);
    expect(r.status, r.stderr).toBe(0);
    expect(pickedOn(r)).toEqual(["aaaaaaaa-done"]);
  });

  test("leaves the page and nothing else, and sweeps pages a day old", () => {
    projects({ "-work-alpha": [{ id: "aaaaaaaa-1", second: 1000 }] });
    const tmp = join(root, "tmp", "sessions-stats");
    mkdirSync(tmp, { recursive: true });
    const stale = join(tmp, "old.html");
    writeFileSync(stale, "<html></html>");
    utimesSync(stale, 1000, 1000);

    const r = stats(["--recent", "--no-open"]);
    expect(r.status, r.stderr).toBe(0);
    expect(readdirSync(tmp)).toEqual(["recent.html"]);
  });

  test("refuses an age it cannot read rather than reporting everything", () => {
    projects({ "-work-alpha": [{ id: "aaaaaaaa-1", second: 1000 }] });
    const r = stats(["--since", "3days", "--no-open"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("--since takes an age");
  });

  test("relays a model the report could not price", () => {
    projects({
      "-work-alpha": [
        {
          id: "aaaaaaaa-1",
          body: [
            prompt,
            turn.replace("claude-sonnet-5", "claude-future-9"),
          ].join("\n"),
          second: 1000,
        },
      ],
    });
    const r = stats(["--recent", "--no-open"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/^unpriced: future-9 /m);
  });

  test("says so when no session has a model turn", () => {
    projects({
      "-work-alpha": [{ id: "aaaaaaaa-1", body: prompt, second: 1000 }],
    });
    const r = stats(["--recent", "--no-open"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("no session with a model turn");
  });
});

describe("run-stats.mjs --session with several ids", () => {
  test("puts the named sessions, from any project, on one page", () => {
    projects({
      "-work-alpha": [{ id: "aaaaaaaa-1", second: 1000 }],
      "-work-beta": [{ id: "bbbbbbbb-2", second: 2000 }],
    });
    const r = stats(["--session", "bbbbbbbb-2,aaaaaaaa-1", "--no-open"]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("2 sessions");
    expect(pageOf(r)).toBe(
      join(root, "tmp", "sessions-stats", "bbbbbbbb+2.html"),
    );
    expect(pickedOn(r).sort()).toEqual(["aaaaaaaa-1", "bbbbbbbb-2"]);
  });

  test("leaves out a session with no model turn, and one with no transcript", () => {
    projects({
      "-work-alpha": [
        { id: "aaaaaaaa-done", second: 1000 },
        { id: "aaaaaaaa-fresh", body: prompt, second: 2000 },
      ],
    });
    const r = stats([
      "--session",
      "aaaaaaaa-done,aaaaaaaa-fresh,cccccccc-gone",
      "--no-open",
    ]);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("no transcript for session cccccccc");
    expect(pickedOn(r)).toEqual(["aaaaaaaa-done"]);
    expect(readdirSync(join(root, "tmp", "sessions-stats"))).toEqual([
      "aaaaaaaa+1.html",
    ]);
  });

  test("says so when none of them has a model turn, and leaves no store", () => {
    projects({
      "-work-alpha": [
        { id: "aaaaaaaa-1", body: prompt, second: 1000 },
        { id: "aaaaaaaa-2", body: prompt, second: 2000 },
      ],
    });
    const r = stats(["--session", "aaaaaaaa-1,aaaaaaaa-2", "--no-open"]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("none of the 2 sessions has a model turn");
    const tmp = join(root, "tmp", "sessions-stats");
    expect(existsSync(tmp) ? readdirSync(tmp) : []).toEqual([]);
  });
});
