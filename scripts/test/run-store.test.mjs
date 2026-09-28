// Tests for the run store.
//
// The property that matters is idempotence. The whole point of archiving raw transcripts is
// that the derivation can be improved and replayed over the history; if a second ingest of
// the same session appended instead of replacing, every re-derivation would double the
// archive and every trend line would be a lie.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { makeClassifier } from "../lib/activity.mjs";
import { buildRun } from "../lib/run-model.mjs";
import { ingestedRuns, openStore, writeRun } from "../lib/run-store.mjs";

const classify = makeClassifier();
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

const body = [
  JSON.stringify({
    type: "assistant",
    timestamp: at(0),
    message: {
      id: "msg-1",
      model: "claude-sonnet-5",
      usage: {
        input_tokens: 0,
        output_tokens: 10,
        cache_read_input_tokens: 1000,
        cache_creation_input_tokens: 0,
      },
      content: [
        {
          type: "tool_use",
          id: "t1",
          name: "Read",
          input: { file_path: "/a.ts" },
        },
      ],
    },
  }),
  JSON.stringify({
    type: "user",
    timestamp: at(1000),
    message: {
      content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }],
    },
  }),
].join("\n");

const run = (over = {}) =>
  buildRun({
    sessionId: "s1",
    slug: "-p",
    mainBody: body,
    agents: [
      { agentId: "agent-1", body, meta: { agentType: "aiharness:developer" } },
    ],
    hooksLog: "[2026-09-01T10:00:00.000Z] [bash-guard] BLOCKED npm run e2e",
    classify,
    ...over,
  });

let TMP = null;
const store = () => {
  TMP = mkdtempSync(join(tmpdir(), "run-store-"));
  return openStore(join(TMP, "runs.sqlite"));
};

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

const count = (db, table) =>
  db.prepare(`SELECT count(*) n FROM ${table}`).get().n;

describe("writeRun", () => {
  test("writes the run and every child table", () => {
    const db = store();
    writeRun(db, run());
    expect(count(db, "runs")).toBe(1);
    expect(count(db, "agents")).toBe(2);
    expect(count(db, "turns")).toBe(2);
    expect(count(db, "calls")).toBe(2);
    expect(count(db, "activities")).toBeGreaterThan(0);
    expect(count(db, "hooks")).toBe(1);
  });

  test("re-ingesting the same session replaces it instead of appending", () => {
    const db = store();
    writeRun(db, run());
    writeRun(db, run());
    expect(count(db, "runs")).toBe(1);
    expect(count(db, "agents")).toBe(2);
    expect(count(db, "calls")).toBe(2);
  });

  test("re-ingesting does not disturb another session's rows", () => {
    const db = store();
    writeRun(db, run());
    writeRun(db, run({ sessionId: "s2" }));
    writeRun(db, run());
    expect(count(db, "runs")).toBe(2);
    expect(
      ingestedRuns(db)
        .map((r) => r.session_id)
        .sort(),
    ).toEqual(["s1", "s2"]);
  });

  test("the arm and label a run was tagged with survive the round trip", () => {
    const db = store();
    writeRun(db, run({ tags: { arm: "B", label: "bugfix contact filter" } }));
    const row = db
      .prepare(`SELECT arm, label FROM runs WHERE session_id = 's1'`)
      .get();
    expect(row).toMatchObject({ arm: "B", label: "bugfix contact filter" });
  });

  test("a hooks.log that was swept is recorded as absent, not as silence", () => {
    const db = store();
    writeRun(db, run({ hooksLog: "" }));
    const row = db
      .prepare(`SELECT has_hooks_log FROM runs WHERE session_id = 's1'`)
      .get();
    expect(row.has_hooks_log).toBe(0);
  });

  test("the schema version is stamped, so a stale derivation is detectable", () => {
    const db = store();
    writeRun(db, run());
    expect(ingestedRuns(db)[0].schema_version).toBe(run().schemaVersion);
  });
});

describe("the store answers questions the report did not anticipate", () => {
  test("which files an agent read, straight from SQL", () => {
    const db = store();
    writeRun(db, run());
    const rows = db
      .prepare(
        `SELECT path, count(*) n FROM calls WHERE tool = 'Read' GROUP BY path`,
      )
      .all();
    expect(rows).toEqual([{ path: "/a.ts", n: 2 }]);
  });
});
