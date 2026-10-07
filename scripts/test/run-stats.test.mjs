// Tests for run-stats.mjs: which session it picks when none is named, and that it ends on
// a page, or on a sentence saying why there is none.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { latestSession, projectSlug } from "../lib/stat-target.mjs";

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
      APP_DIR: repo,
      CLAUDE_CONFIG_DIR: join(root, "config"),
      HARNESS_TMP_ROOT: join(root, "tmp"),
      CLAUDE_PROJECT_DIR: "",
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
    const page = join(root, "tmp", "harness-stat", "bbbbbbbb.html");
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
});
