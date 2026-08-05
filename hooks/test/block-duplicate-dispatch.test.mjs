// Tests for block-duplicate-dispatch.mjs — the PreToolUse(Agent) gate that
// stops accidental duplicate dispatches. Two concerns:
//   1. planner: at most one per (caller, TICKETS_DIR).
//   2. developer/quality-reviewer/merger: debounce identical re-dispatches
//      inside a short window (the async-runtime "Async agent launched" trap).
// A block is emitted via decisionBlock: exit 0 with {"decision":"block"} on
// stdout (NOT exit 2). An allowed dispatch exits 0 with no decision JSON.

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "block-duplicate-dispatch.mjs");
const SESSION_ID = "ab12cd34-1111-2222-3333-444455556666";
const CALLER = "orchestrator-agent-1";

let TMP;
let APP_DIR;
let breakerDir;
let env;

// Returns { blocked: boolean } — blocked when the decisionBlock JSON is printed.
// runInBackground defaults to false: in the real harness (post force-foreground)
// every pipeline dispatch carries run_in_background:false, and block-duplicate only
// debounces those. Pass `undefined` to simulate the malformed (absent) dispatch that
// force-foreground denies — block-duplicate must skip it (no marker).
const run = (
  prompt,
  subagentType,
  agentId = CALLER,
  runInBackground = false,
) => {
  const tool_input = { subagent_type: subagentType, prompt };
  // Pass the sentinel "absent" to OMIT the field (a default param can't express this:
  // passing `undefined` still triggers the default). "absent" simulates the malformed
  // dispatch force-foreground denies.
  if (runInBackground !== "absent")
    tool_input.run_in_background = runInBackground;
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      agent_id: agentId,
      tool_input,
    }),
    env,
    encoding: "utf8",
  });
  return {
    blocked: /"decision":"block"/.test(r.stdout || ""),
    status: r.status,
  };
};

// Seed a plan in a TICKETS_DIR. The planner debounce fires only when a plan EXISTS, so a
// test that expects a second planner to be blocked has to have produced one first.
const seedPlan = (dir) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TASK-001.json"), JSON.stringify({ id: "TASK-001" }));
  return dir;
};

// Backdate every marker so the next dispatch sees it as outside the debounce
// window (and a planner marker as stale).
const ageMarkers = (secondsAgo) => {
  const when = Date.now() / 1000 - secondsAgo;
  for (const f of readdirSync(breakerDir)) {
    utimesSync(join(breakerDir, f), when, when);
  }
};

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "block-dup-dispatch-test-"));
  APP_DIR = join(TMP, "app");
  const HARNESS_TMP_ROOT = join(TMP, "scratch");
  breakerDir = join(
    HARNESS_TMP_ROOT,
    sanitizePath(APP_DIR),
    SESSION_ID,
    "breaker",
  );
  mkdirSync(breakerDir, { recursive: true });
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT };
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("block-duplicate-dispatch — planner", () => {
  test("allows the first planner, blocks the second for the same TICKETS_DIR", () => {
    const dir = join(TMP, "tickets");
    const p = `TICKETS_DIR=${dir}`;
    expect(run(p, "planner").blocked).toBe(false);
    seedPlan(dir); // the first planner produced a plan
    expect(run(p, "planner").blocked).toBe(true);
  });

  test("allows a planner again once the marker is stale (>1h)", () => {
    ageMarkers(2 * 60 * 60); // 2h
    const p = `TICKETS_DIR=${join(TMP, "tickets")}`;
    expect(run(p, "planner").blocked).toBe(false);
  });
});

describe("block-duplicate-dispatch — reviewer/developer/merger debounce", () => {
  test("blocks a second quality-reviewer for the same ticket within the window", () => {
    const p = `ROLE: quality-reviewer\nTASK_ID: TASK-100\nWORKTREE_PATH: /wt`;
    expect(run(p, "quality-reviewer").blocked).toBe(false);
    expect(run(p, "quality-reviewer").blocked).toBe(true);
  });

  test("allows a reviewer for a different ticket", () => {
    expect(
      run(
        `ROLE: quality-reviewer\nTASK_ID: TASK-200\nWORKTREE_PATH: /wt`,
        "quality-reviewer",
      ).blocked,
    ).toBe(false);
  });

  test("allows the same reviewer again once outside the debounce window", () => {
    ageMarkers(5 * 60); // 5 min — well past the 90s window
    expect(
      run(
        `ROLE: quality-reviewer\nTASK_ID: TASK-100\nWORKTREE_PATH: /wt`,
        "quality-reviewer",
      ).blocked,
    ).toBe(false);
  });

  test("debounces by ticket, not role: a merger for a fresh ticket is allowed", () => {
    expect(
      run(`ROLE: merger\nTASK_ID: TASK-300\nBRANCH_NAME: x`, "merger").blocked,
    ).toBe(false);
  });

  test("a different caller is not debounced against the first caller's marker", () => {
    const p = `ROLE: developer\nTASK_ID: TASK-400\nWORKTREE_PATH: /wt`;
    expect(run(p, "developer", "orchestrator-A").blocked).toBe(false);
    expect(run(p, "developer", "orchestrator-B").blocked).toBe(false);
  });

  test("falls back to a prompt hash when there is no TASK_ID (SIMPLE flow)", () => {
    const p = `ROLE: developer\nCHANGE_REQUEST: rename the button\nWORKTREE_PATH: /wt`;
    expect(run(p, "developer").blocked).toBe(false);
    expect(run(p, "developer").blocked).toBe(true); // identical prompt → duplicate
    // A different change request is a distinct dispatch, not a duplicate.
    expect(
      run(
        `ROLE: developer\nCHANGE_REQUEST: hide the export\nWORKTREE_PATH: /wt`,
        "developer",
      ).blocked,
    ).toBe(false);
  });
});

describe("block-duplicate-dispatch — pass-through", () => {
  test("ignores roles outside the debounce set (documentator)", () => {
    const p = `ROLE: documentator`;
    expect(run(p, "documentator").blocked).toBe(false);
    expect(run(p, "documentator").blocked).toBe(false); // never debounced
  });

  test("allows when no caller agent_id is present (can't scope a marker)", () => {
    const r = run(
      `ROLE: quality-reviewer\nTASK_ID: TASK-100\nWORKTREE_PATH: /wt`,
      "quality-reviewer",
      "",
    );
    expect(r.blocked).toBe(false);
  });
});

describe("block-duplicate-dispatch — the planner marker means A PLAN EXISTS", () => {
  // A marker records that a planner was DISPATCHED. A planner that died before writing
  // anything (observed live: lost to a transient API 529 overload) leaves the marker with no
  // tickets, and refusing the retry then wedges planning for the whole stale window. The
  // invariant is "never overwrite an existing plan", so with no plan there is nothing to
  // protect.
  const ticketsFor = (name) => {
    const dir = join(TMP, name);
    mkdirSync(dir, { recursive: true });
    return dir;
  };

  test("a retry is allowed when the first planner produced no tickets", () => {
    const dir = ticketsFor("tickets-empty");
    const prompt = `TICKETS_DIR=${dir}`;
    const CALLER_A = "retry-orch";
    expect(run(prompt, "planner", CALLER_A).blocked).toBe(false); // first
    expect(run(prompt, "planner", CALLER_A).blocked).toBe(false); // retry, no plan yet
    expect(run(prompt, "planner", CALLER_A).blocked).toBe(false); // and again
  });

  test("a second planner IS blocked once a plan exists", () => {
    const dir = ticketsFor("tickets-planned");
    const prompt = `TICKETS_DIR=${dir}`;
    const CALLER_B = "planned-orch";
    expect(run(prompt, "planner", CALLER_B).blocked).toBe(false);
    writeFileSync(
      join(dir, "TASK-001.json"),
      JSON.stringify({ id: "TASK-001" }),
    );
    expect(run(prompt, "planner", CALLER_B).blocked).toBe(true);
  });

  test("the block message says a plan exists, so the reader knows why", () => {
    const dir = ticketsFor("tickets-msg");
    const prompt = `TICKETS_DIR=${dir}`;
    const CALLER_C = "msg-orch";
    run(prompt, "planner", CALLER_C);
    writeFileSync(join(dir, "TASK-002.json"), "{}");
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        session_id: SESSION_ID,
        agent_id: CALLER_C,
        tool_input: {
          subagent_type: "planner",
          prompt,
          run_in_background: false,
        },
      }),
      env,
      encoding: "utf8",
    });
    expect(r.stdout).toContain("a plan exists");
  });

  // A file that merely looks ticket-ish is not a plan.
  test("a non-ticket file in the dir does not count as a plan", () => {
    const dir = ticketsFor("tickets-noise");
    const prompt = `TICKETS_DIR=${dir}`;
    const CALLER_D = "noise-orch";
    run(prompt, "planner", CALLER_D);
    writeFileSync(join(dir, "notes.md"), "not a ticket");
    writeFileSync(join(dir, "TASK-abc.json"), "{}");
    expect(run(prompt, "planner", CALLER_D).blocked).toBe(false);
  });
});

describe("block-duplicate-dispatch — agreement with force-foreground", () => {
  // The debounce must cover exactly the dispatches that PROCEED. force-foreground denies
  // only an explicit true, so an explicit true is the only form to skip: recording a marker
  // for a denied attempt would reject the corrective retry as a duplicate (that wedged
  // planning for 60 min once).
  test("an explicitly backgrounded dispatch is skipped, so its retry is not a duplicate", () => {
    const p = `TICKETS_DIR=${join(TMP, "tickets-ff")}`;
    const FF = "ff-orch"; // unique caller: no marker collision with earlier tests
    expect(run(p, "planner", FF, true).blocked).toBe(false); // denied form -> skipped, no marker
    expect(run(p, "planner", FF, false).blocked).toBe(false); // the retry proceeds
    seedPlan(join(TMP, "tickets-ff"));
    expect(run(p, "planner", FF, false).blocked).toBe(true); // a genuine 2nd planner is blocked
  });

  // The bug this replaces: the skip condition was `run_in_background !== false`, and a
  // nested subagent's Agent tool does not expose the parameter, so EVERY pipeline dispatch
  // exited early and the debounce was silently off. Observed as two planner dispatches
  // twelve seconds apart, with no log line from this hook at all.
  test("a dispatch with no run_in_background key is still debounced", () => {
    const p = `TICKETS_DIR=${join(TMP, "tickets-absent")}`;
    const CALLER = "absent-orch";
    expect(run(p, "planner", CALLER, "absent").blocked).toBe(false); // first one proceeds
    seedPlan(join(TMP, "tickets-absent"));
    expect(run(p, "planner", CALLER, "absent").blocked).toBe(true); // second is caught
  });
});
