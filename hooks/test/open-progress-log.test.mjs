// The technical run's live feed must exist because a HOOK created it, not because the
// orchestrator remembered to.
//
// orchestrator.md tells it to append each milestone with a Bash echo. That is an instruction,
// not a gate: an orchestrator that skips it leaves a `#technical-harness` run with no live feed
// and no board either, because render-status is gated on that same file existing.
//
// The file's EXISTENCE stays the technical-run gate, so this is keyed on the dispatch
// declaring `PERSONA: technical` and must never fire on a normal or web-chat run.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "open-progress-log.mjs");
const SESSION_ID = "0pg1a2b3-1111-2222-3333-444455556666";

let TMP, APP_DIR, sessionDir, env;

const dispatch = (prompt, subagentType = "orchestrator") =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: { subagent_type: subagentType, prompt },
    }),
    env,
    encoding: "utf8",
  });

const log = () => join(sessionDir, "harness-progress.log");

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "open-progress-log-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  sessionDir = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(APP_DIR, { recursive: true });
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.CHAT_SESSION_DIR;
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("open-progress-log", () => {
  test("creates the log when the dispatch declares PERSONA: technical", () => {
    const r = dispatch(
      "GATE: plan\nPERSONA: technical\n<session_dir>/tmp/x</session_dir>\nAdd a field.",
    );
    expect(r.status).toBe(0);
    expect(existsSync(log())).toBe(true);
    expect(readFileSync(log(), "utf8")).toContain("PERSONA: technical");
  });

  test("stays inert on a run that did not ask for the technical persona", () => {
    const r = dispatch("GATE: plan\nAdd a field.");
    expect(r.status).toBe(0);
    expect(existsSync(log())).toBe(false);
  });

  test("a mention inside prose is not a declaration", () => {
    dispatch("Explain what PERSONA: technical would change for me.");
    expect(existsSync(log())).toBe(false);
  });

  test("never truncates a log the run has already been writing to", () => {
    dispatch("PERSONA: technical\nfirst dispatch");
    const before = readFileSync(log(), "utf8");
    dispatch("PERSONA: technical\nsecond dispatch");
    expect(readFileSync(log(), "utf8")).toBe(before);
  });

  test("it is a recorder, not a guard: nothing is ever blocked", () => {
    for (const prompt of ["PERSONA: technical\nx", "no persona here"]) {
      const r = dispatch(prompt);
      expect(r.status).toBe(0);
      expect(r.stdout).not.toContain('"decision"');
    }
  });
});
