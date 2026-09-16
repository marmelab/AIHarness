// Tests for warn-ungrilled-plan: the only mechanical link between the plan gate and the
// grill. Everything else about the grill is asserted in prose, and a coordinator that
// simply skips the skill produces a run byte-identical to a plan that derived nothing.
//
// The guard is ADVISORY by construction, so the load-bearing assertion in every case is
// that it exits 0. A dispatch the human already approved must never be refused by a
// bookkeeping guard.

import { afterEach, describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sanitizePath } from "../lib/paths.mjs";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "warn-ungrilled-plan.mjs",
);

const SESSION_ID = "ungrilled-test";

let root = null;
let env = null;
let ticketsDir = null;
const startSession = () => {
  root = mkdtempSync(join(tmpdir(), "ungrilled-"));
  const appDir = join(root, "repo");
  const tmpRoot = join(root, "scratch");
  env = { ...process.env, APP_DIR: appDir, HARNESS_TMP_ROOT: tmpRoot };
  delete env.CLAUDE_PROJECT_DIR;
  delete env.TICKETS_DIR;
  ticketsDir = join(tmpRoot, sanitizePath(appDir), SESSION_ID, "tickets");
  mkdirSync(ticketsDir, { recursive: true });
};
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
  env = null;
  ticketsDir = null;
});

const writeTicket = (id, ticket) => {
  if (!ticketsDir) startSession();
  writeFileSync(join(ticketsDir, `${id}.json`), ticket);
};

const EXECUTE_PLAN = "<intent>execute-plan</intent>\nbuild the thing";

const dispatch = ({
  role = "aiharness:orchestrator",
  prompt = EXECUTE_PLAN,
  sessionId = SESSION_ID,
} = {}) => {
  if (!env) startSession();
  const payload = {
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: { subagent_type: role, description: "resume", prompt },
  };
  if (sessionId) payload.session_id = sessionId;
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    env,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
};

/** Did the guard emit its advisory context? */
const warned = (r) =>
  r.stdout.includes('"additionalContext"') &&
  r.stdout.includes("warn-ungrilled-plan");

const DERIVED_TICKET = JSON.stringify({
  id: "TASK-001",
  acceptance_criteria: [
    { text: "from the ask", source: "request" },
    { text: "my judgement", source: "derived" },
  ],
  open_questions: [{ id: "Q1", question: "persist?", grade: "arch" }],
});

describe("warn-ungrilled-plan", () => {
  test("warns when the plan derived rows and no ticket carries a grill", () => {
    writeTicket("TASK-001", DERIVED_TICKET);
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(true);
  });

  test("the warning names the count and the directory it read", () => {
    writeTicket("TASK-001", DERIVED_TICKET);
    const r = dispatch();
    expect(r.stdout).toContain("2");
    expect(r.stdout).toContain(ticketsDir);
  });

  test("the count is summed across every ticket", () => {
    writeTicket("TASK-001", DERIVED_TICKET);
    writeTicket(
      "TASK-002",
      JSON.stringify({
        id: "TASK-002",
        acceptance_criteria: [{ text: "also mine", source: "derived" }],
      }),
    );
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("3");
  });

  test("is silent when a ticket carries a grill entry", () => {
    writeTicket(
      "TASK-001",
      JSON.stringify({
        id: "TASK-001",
        acceptance_criteria: [{ text: "my judgement", source: "derived" }],
        grill: [{ id: "Q1", question: "persist?", answer: "no" }],
      }),
    );
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(false);
  });

  // One grilled ticket answers for the plan: the skill hands back after a single pass
  // over every ticket, so a run where it executed leaves at least one record.
  test("one grilled ticket is enough, even beside an ungrilled one", () => {
    writeTicket("TASK-001", DERIVED_TICKET);
    writeTicket(
      "TASK-002",
      JSON.stringify({
        id: "TASK-002",
        acceptance_criteria: [{ text: "mine too", source: "derived" }],
        grill: [{ id: "Q1", question: "persist?", answer: "no" }],
      }),
    );
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(false);
  });

  test("a half-written grill entry does not count as a decision", () => {
    writeTicket(
      "TASK-001",
      JSON.stringify({
        id: "TASK-001",
        acceptance_criteria: [{ text: "my judgement", source: "derived" }],
        grill: [{ id: "Q1", question: "persist?" }],
      }),
    );
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(true);
  });

  test("is silent when nothing was derived", () => {
    writeTicket(
      "TASK-001",
      JSON.stringify({
        id: "TASK-001",
        acceptance_criteria: [{ text: "from the ask", source: "request" }],
      }),
    );
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(false);
  });

  test("a legacy ticket derives nothing, so it is silent", () => {
    writeTicket(
      "TASK-001",
      JSON.stringify({ id: "TASK-001", acceptance_criteria: ["plain line"] }),
    );
    const r = dispatch();
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(false);
  });

  test("is silent on a dispatch that carries no execute-plan intent", () => {
    writeTicket("TASK-001", DERIVED_TICKET);
    const r = dispatch({ prompt: "LEVEL: feature\nGATE: plan" });
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(false);
  });

  test("is silent on another intent's resume", () => {
    writeTicket("TASK-001", DERIVED_TICKET);
    const r = dispatch({ prompt: "<intent>recovery</intent>" });
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(false);
  });

  describe("only the orchestrator's own resume is in scope", () => {
    test.each([
      "aiharness:developer",
      "aiharness:planner",
      "aiharness:quality-reviewer",
      "general-purpose",
    ])("%s is never warned about", (role) => {
      writeTicket("TASK-001", DERIVED_TICKET);
      const r = dispatch({ role });
      expect(r.status).toBe(0);
      expect(warned(r)).toBe(false);
    });

    test("a bare orchestrator role is in scope, like a namespaced one", () => {
      writeTicket("TASK-001", DERIVED_TICKET);
      expect(warned(dispatch({ role: "orchestrator" }))).toBe(true);
      expect(warned(dispatch({ role: "chat-orchestrator" }))).toBe(true);
    });
  });

  describe("fails open on ignorance", () => {
    test("no ticket file anywhere is allowed in silence", () => {
      startSession();
      const r = dispatch();
      expect(r.status).toBe(0);
      expect(warned(r)).toBe(false);
    });

    test("an unreadable ticket stops the check rather than guessing", () => {
      writeTicket("TASK-001", DERIVED_TICKET);
      writeTicket("TASK-002", "{ not json");
      const r = dispatch();
      expect(r.status).toBe(0);
      expect(warned(r)).toBe(false);
    });

    test("no session id is allowed in silence", () => {
      startSession();
      const r = dispatch({ sessionId: "" });
      expect(r.status).toBe(0);
      expect(warned(r)).toBe(false);
    });

    test("an unparseable payload is allowed in silence", () => {
      startSession();
      const r = spawnSync("node", [HOOK], {
        input: "not json at all",
        encoding: "utf8",
        env,
      });
      expect(r.status).toBe(0);
      expect(warned({ stdout: r.stdout })).toBe(false);
    });
  });

  // Standalone is the shape every hook test uses, but the runtime reaches this guard
  // through the PreToolUse(Agent) dispatcher. A guard that works alone and is not in the
  // chain is exactly the inert guard this one exists to prevent.
  test("fires through the pre-tool-agent chain, where the runtime reaches it", () => {
    writeTicket("TASK-001", DERIVED_TICKET);
    const r = spawnSync(
      "node",
      [
        join(
          dirname(fileURLToPath(import.meta.url)),
          "..",
          "pre-tool-agent.mjs",
        ),
      ],
      {
        input: JSON.stringify({
          session_id: SESSION_ID,
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: {
            subagent_type: "aiharness:orchestrator",
            description: "resume",
            prompt: EXECUTE_PLAN,
          },
        }),
        encoding: "utf8",
        env,
      },
    );
    expect(r.status).toBe(0);
    expect(warned(r)).toBe(true);
  });

  // Advisory means advisory: the human has already approved this plan at the gate, so
  // nothing here may cost them the dispatch.
  test("never exits non-zero, whatever it is handed", () => {
    const cases = [
      () => dispatch(),
      () => dispatch({ role: "aiharness:developer" }),
      () => dispatch({ prompt: "" }),
      () => dispatch({ sessionId: "" }),
    ];
    writeTicket("TASK-001", DERIVED_TICKET);
    for (const c of cases) expect(c().status).toBe(0);
  });
});
