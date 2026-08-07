// Tests for lib/scratchpad.mjs: resolving the runtime's per-session scratchpad
// directory from a session id, and recognising a redirect target that lives in it.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { isScratchpadTarget, scratchpadDir } from "../lib/scratchpad.mjs";

const TMP = mkdtempSync(join(tmpdir(), "scratchpad-test-"));
const SESSION = "13afe5d3-e162-4b8b-9948-74d79e50ec15";
const REAL = join(TMP, "claude-1000", "-workspaces-app", SESSION, "scratchpad");
mkdirSync(REAL, { recursive: true });
// A neighbouring session under the same root must not be mistaken for this one.
mkdirSync(join(TMP, "claude-1000", "-workspaces-app", "other", "scratchpad"), {
  recursive: true,
});
// A non-scratchpad tmp entry must not derail the scan.
mkdirSync(join(TMP, "not-claude"), { recursive: true });

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("scratchpadDir", () => {
  test("finds the directory for the session id", () => {
    expect(scratchpadDir(SESSION, TMP)).toBe(REAL);
  });

  test("returns '' for a session with no scratchpad", () => {
    expect(scratchpadDir("no-such-session", TMP)).toBe("");
  });

  test("returns '' for an empty session id, and never throws on a missing root", () => {
    expect(scratchpadDir("", TMP)).toBe("");
    expect(scratchpadDir(SESSION, join(TMP, "absent"))).toBe("");
  });
});

describe("isScratchpadTarget", () => {
  test("a file under the resolved directory belongs to the session", () => {
    expect(isScratchpadTarget(join(REAL, "demo.log"), SESSION, TMP)).toBe(true);
  });

  // The guard has to recognise the target BEFORE anything is written there, so
  // the shape alone is enough: resolution is an optimisation, not the contract.
  test("the path shape matches even when the directory does not exist", () => {
    const unwritten = `/tmp/claude-1000/-other-project/${SESSION}/scratchpad/x.log`;
    expect(scratchpadDir(SESSION, join(TMP, "absent"))).toBe("");
    expect(isScratchpadTarget(unwritten, SESSION, join(TMP, "absent"))).toBe(
      true,
    );
  });

  test("another session's scratchpad does not belong to this one", () => {
    const other = "/tmp/claude-1000/-workspaces-app/other/scratchpad/x.log";
    expect(isScratchpadTarget(other, SESSION, TMP)).toBe(false);
  });

  test("a path merely containing the session id is not the scratchpad", () => {
    expect(isScratchpadTarget(`/tmp/${SESSION}/out.log`, SESSION, TMP)).toBe(
      false,
    );
  });

  test("empty target or session id is never a match", () => {
    expect(isScratchpadTarget("", SESSION, TMP)).toBe(false);
    expect(isScratchpadTarget(join(REAL, "x.log"), "", TMP)).toBe(false);
  });
});
