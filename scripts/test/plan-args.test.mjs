// Tests for plan-args.mjs: the seam between an approved plan and the workflow.
//
// A workflow script has no filesystem, so everything it knows about the session arrives
// as one JSON value. Getting this wrong is quiet in the worst way: a missing ticket runs
// a partial plan and reports success, and a wrong worktreeBase sends every developer to
// a directory the merger will not look in.

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "..", "plan-args.mjs");
const SESSION_ID = "ef5678ab-1111-2222-3333-444455556666";

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

/** A tickets directory, and the env that points the CLI at it. */
const session = (tickets) => {
  TMP = mkdtempSync(join(tmpdir(), "plan-args-"));
  const dir = join(TMP, "tickets");
  mkdirSync(dir, { recursive: true });
  for (const t of tickets)
    writeFileSync(
      join(dir, `${t.id}.json`),
      typeof t.raw === "string" ? t.raw : JSON.stringify(t),
    );
  return {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: SESSION_ID,
    TICKETS_DIR: dir,
    HARNESS_TMP_ROOT: join(TMP, "scratch"),
  };
};

const run = (env, ...argv) =>
  spawnSync("node", [CLI, ...argv], { env, encoding: "utf8" });

const parse = (r) => JSON.parse(r.stdout);

describe("plan-args", () => {
  test("carries the topology the workflow cannot look up for itself", () => {
    const r = run(session([{ id: "TASK-001", dependencies: [] }]));
    expect(r.status).toBe(0);
    const out = parse(r);
    expect(out.sessionShort).toBe("ef5678ab");
    expect(out.worktreeBase).toContain(SESSION_ID);
    expect(out.ticketsDir).toContain("tickets");
  });

  test("passes only the fields the script reads", () => {
    // A whole ticket body would put the plan back into a context window, which is what
    // the workflow exists to avoid: the agents read their own TICKET_FILE.
    const r = run(
      session([
        {
          id: "TASK-001",
          dependencies: ["TASK-000"],
          tier: "hard",
          title: "a long title",
          acceptance_criteria: ["one", "two"],
          body: "x".repeat(5000),
        },
      ]),
    );
    const t = parse(r).tickets[0];
    expect(Object.keys(t).sort()).toEqual([
      "dependencies",
      "id",
      "parallel_safe",
      "tier",
    ]);
    expect(t.dependencies).toEqual(["TASK-000"]);
    expect(t.tier).toBe("hard");
  });

  test("a ticket that says nothing about parallelism is parallel-safe", () => {
    const r = run(session([{ id: "TASK-001" }]));
    expect(parse(r).tickets[0].parallel_safe).toBe(true);
  });

  test("only an explicit false makes a ticket solo", () => {
    const r = run(session([{ id: "TASK-001", parallel_safe: false }]));
    expect(parse(r).tickets[0].parallel_safe).toBe(false);
  });

  test("--pending leaves out what is already merged", () => {
    const env = session([
      { id: "TASK-001", status: "merged" },
      { id: "TASK-002", status: "planned" },
    ]);
    expect(parse(run(env)).tickets).toHaveLength(2);
    expect(parse(run(env, "--pending")).tickets.map((t) => t.id)).toEqual([
      "TASK-002",
    ]);
  });

  test("an unreadable ticket stops the run instead of shrinking the plan", () => {
    // Dropping it quietly would execute a partial plan and report success.
    const r = run(
      session([{ id: "TASK-001" }, { id: "TASK-002", raw: "{ not json" }]),
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("could not be parsed");
  });

  test("no tickets at all says to plan first", () => {
    TMP = mkdtempSync(join(tmpdir(), "plan-args-"));
    const dir = join(TMP, "tickets");
    mkdirSync(dir, { recursive: true });
    const r = run({
      ...process.env,
      CLAUDE_CODE_SESSION_ID: SESSION_ID,
      TICKETS_DIR: dir,
      HARNESS_TMP_ROOT: join(TMP, "scratch"),
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("executes an approved plan");
  });

  test("everything merged is refused rather than run as an empty plan", () => {
    const r = run(session([{ id: "TASK-001", status: "merged" }]), "--pending");
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("already merged");
  });

  test("--session names the run, since a terminal has no session id", () => {
    // The id is in the environment inside a Claude session and nowhere outside one,
    // which is where a person runs this.
    const env = session([{ id: "TASK-001" }]);
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = run(env, "--session", SESSION_ID);
    expect(r.status).toBe(0);
    expect(parse(r).sessionShort).toBe("ef5678ab");
  });

  test("no id at all is refused, not keyed on a shared path", () => {
    const env = session([{ id: "TASK-001" }]);
    delete env.CLAUDE_CODE_SESSION_ID;
    const r = run(env);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("--session");
  });

  test("the output is the JSON the Workflow tool takes as args", () => {
    const r = run(session([{ id: "TASK-001" }]));
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(r.stdout.trim().startsWith("{")).toBe(true);
  });
});
