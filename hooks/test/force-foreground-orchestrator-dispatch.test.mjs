// Tests for force-foreground-orchestrator-dispatch.mjs. The gate exists because a nested
// subagent is never re-invoked when a background child completes, so a backgrounded
// pipeline dispatch orphans review/merge/promotion.
//
// It blocks an EXPLICIT true and accepts absent. Requiring an explicit false deadlocked the
// harness in a runtime whose nested Agent tool does not expose the parameter: the
// orchestrator could not comply, and every pipeline dispatch was refused. The residual risk
// in the absent case is covered by completion-invariant, which rejects a stop that leaves
// APPROVED work unmerged.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "force-foreground-orchestrator-dispatch.mjs");
const TMP = mkdtempSync(join(tmpdir(), "force-fg-dispatch-"));

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// `runInBackground` omitted entirely when `undefined`, so the payload matches what a
// client that never sends the field actually produces.
const run = ({ subagentType, prompt = "", runInBackground }) => {
  const toolInput = { subagent_type: subagentType, prompt };
  if (runInBackground !== undefined)
    toolInput.run_in_background = runInBackground;
  return spawnSync("node", [HOOK], {
    input: JSON.stringify({
      tool_name: "Agent",
      session_id: "fg-1234",
      tool_input: toolInput,
    }),
    env: { ...process.env, APP_DIR: TMP },
    encoding: "utf8",
  });
};

const isBlocked = (r) => r.stdout.includes('"decision":"block"');

describe("force-foreground-orchestrator-dispatch", () => {
  const PIPELINE = [
    "planner",
    "developer",
    "quality-reviewer",
    "merger",
    "test-writer",
  ];

  test.each(PIPELINE)("%s dispatched in the background → blocked", (role) => {
    const r = run({ subagentType: role, runInBackground: true });
    expect(r.status).toBe(0);
    expect(isBlocked(r)).toBe(true);
    expect(r.stdout).toContain(role);
  });

  // Absent is accepted: a runtime may not offer the parameter to a nested subagent at all,
  // and blocking then refuses every dispatch with no way for the orchestrator to comply.
  test.each(PIPELINE)(
    "%s dispatched with run_in_background absent → allowed",
    (role) => {
      const r = run({ subagentType: role });
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(false);
    },
  );

  test.each(PIPELINE)("%s dispatched with explicit false → allowed", (role) => {
    const r = run({ subagentType: role, runInBackground: false });
    expect(r.status).toBe(0);
    expect(isBlocked(r)).toBe(false);
  });

  // main -> orchestrator and the fire-and-forget documentator are pipeline:false in
  // harness.config.json, so their background dispatch is correct and must pass.
  test.each(["orchestrator", "documentator"])(
    "%s in the background → allowed (not a pipeline role)",
    (role) => {
      expect(
        isBlocked(run({ subagentType: role, runInBackground: true })),
      ).toBe(false);
    },
  );

  test("recognises the child role from the prompt's ROLE: line", () => {
    const r = run({
      subagentType: "",
      prompt: "ROLE: merger\nTASK_ID: TASK-004\n",
      runInBackground: true,
    });
    expect(isBlocked(r)).toBe(true);
    expect(r.stdout).toContain("merger");
  });

  // The exact shape observed in the wild: a nested dispatch whose tool_input carries no
  // run_in_background key at all, five of which were refused in a row before this changed.
  test("the runtime shape that deadlocked the harness now passes", () => {
    const r = run({
      subagentType: "developer",
      prompt: "ROLE: developer\nTASK_ID: TASK-001\n",
    });
    expect(isBlocked(r)).toBe(false);
    expect(r.stdout).not.toContain("must not be EXPLICITLY backgrounded");
  });

  test("an unparseable payload allows the dispatch (fail-open)", () => {
    const r = spawnSync("node", [HOOK], {
      input: "not json",
      env: { ...process.env, APP_DIR: TMP },
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(isBlocked(r)).toBe(false);
  });
});

// In a runtime that exposes no run_in_background, this guard has nothing left to deny, and
// it used to say so on every single dispatch: 35 identical ACCEPT lines in one session's
// log, which buries the lines that mean something.
describe("the inert-runtime note is logged once per session", () => {
  const inertRun = (root, sessionId) =>
    spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_name: "Agent",
        session_id: sessionId,
        tool_input: { subagent_type: "developer", prompt: "" },
      }),
      env: { ...process.env, APP_DIR: TMP, HARNESS_TMP_ROOT: root },
      encoding: "utf8",
    });

  const inertLines = (root, sessionId) => {
    const log = join(root, sanitizePath(TMP), sessionId, "hooks.log");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8")
      .split("\n")
      .filter((l) => l.includes("guard is inert"));
  };

  test("five dispatches produce one note, and none of them is blocked", () => {
    const root = mkdtempSync(join(tmpdir(), "force-fg-inert-"));
    const sessionId = "inert-1234";
    for (let i = 0; i < 5; i++) {
      const r = inertRun(root, sessionId);
      expect(isBlocked(r)).toBe(false);
      expect(r.status).toBe(0);
    }
    expect(inertLines(root, sessionId)).toHaveLength(1);
    // And it corrects the doctrine that caused the re-dispatch, at the source.
    expect(inertLines(root, sessionId)[0]).toContain("task-notification");
    rmSync(root, { recursive: true, force: true });
  });

  test("a new session gets its own note", () => {
    const root = mkdtempSync(join(tmpdir(), "force-fg-inert2-"));
    inertRun(root, "sess-a");
    inertRun(root, "sess-b");
    expect(inertLines(root, "sess-a")).toHaveLength(1);
    expect(inertLines(root, "sess-b")).toHaveLength(1);
    rmSync(root, { recursive: true, force: true });
  });

  // An explicit false is the compliant shape and stays a normal per-dispatch accept: it is
  // not the inert case, so it must not consume or trigger the note.
  test("an explicit false is never reported as inert", () => {
    const root = mkdtempSync(join(tmpdir(), "force-fg-explicit-"));
    spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_name: "Agent",
        session_id: "explicit-1234",
        tool_input: {
          subagent_type: "developer",
          prompt: "",
          run_in_background: false,
        },
      }),
      env: { ...process.env, APP_DIR: TMP, HARNESS_TMP_ROOT: root },
      encoding: "utf8",
    });
    expect(inertLines(root, "explicit-1234")).toHaveLength(0);
    rmSync(root, { recursive: true, force: true });
  });
});
