// Tests for route-review-model: the per-ticket review model, decided by the harness.
//
// What matters is not the rule but the two things that make enforcing it safe: the
// asymmetric direction of each rewrite (SET sonnet, REMOVE model), and fail-open in the
// expensive direction.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO, TMP_ROOT, sanitizePath } from "../lib/paths.mjs";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "route-review-model.mjs",
);

let dirs = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "route-review-"));
  dirs.push(d);
  return d;
};
const cleanup = () => {
  while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true });
};

/**
 * The session topology setup-worktree really builds, in one directory: the anchor
 * `session-base/ab12cd34` at the fork point, then any `alreadyOnSession` commits that
 * earlier waves merged, then `session/ab12cd34` on top of those (every worktree, the
 * simple one included, is cut from the session branch), and finally this worktree's own
 * work: `files` files of `lines` lines each plus every path in `paths`.
 *
 * The range under review is therefore the worktree's own commits, and `alreadyOnSession`
 * is what separates the two candidate bases: it is inside the anchor's range and outside
 * the session branch's.
 */
const gitRepo = (
  dir,
  { files = 1, lines = 1, paths = [], alreadyOnSession } = {},
) => {
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  const write = (rel, n) => {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(
      join(dir, rel),
      Array.from({ length: n }, (_, k) => `l${k}`).join("\n") + "\n",
    );
  };
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g("add", "-A");
  g("commit", "-qm", "seed");
  g("branch", "session-base/ab12cd34");
  if (alreadyOnSession) {
    for (let i = 0; i < (alreadyOnSession.files ?? 0); i++)
      write(`wave${i}.txt`, alreadyOnSession.lines ?? 1);
    for (const rel of alreadyOnSession.paths ?? []) write(rel, 1);
    g("add", "-A");
    g("commit", "-qm", "an earlier wave");
  }
  g("branch", "session/ab12cd34");
  for (let i = 0; i < files; i++) write(`f${i}.txt`, lines);
  for (const rel of paths) write(rel, 1);
  g("add", "-A");
  g("commit", "-qm", "work");
};

/**
 * Run the guard on a reviewer dispatch for a ticket with the given fields.
 * @returns {{status: number, updated: object|null, stdout: string, ticketFile: string}}
 */
const run = ({
  ticket,
  model,
  mode,
  inlineMode,
  taskId = "TASK-001",
  omitTicketFile,
  omitBranchName,
  simple,
  diff,
  extraLines = [],
  sessionId = "ab12cd34-0000-0000-0000-000000000000",
} = {}) => {
  const dir = tmp();
  const ticketFile = join(dir, `${taskId}.json`);
  if (ticket !== undefined) writeFileSync(ticketFile, JSON.stringify(ticket));
  if (diff) gitRepo(dir, diff);
  const branchLine = simple
    ? ["BRANCH_NAME: ab12cd34/simple"]
    : diff && !omitBranchName
      ? ["BRANCH_NAME: ab12cd34/TASK-001"]
      : [];
  const lines = [
    inlineMode
      ? `ROLE: quality-reviewer (MODE: ${inlineMode})`
      : "ROLE: quality-reviewer",
    `TASK_ID: ${taskId}`,
    ...(omitTicketFile ? [] : [`TICKET_FILE: ${ticketFile}`]),
    `WORKTREE_PATH: ${dir}`,
    ...branchLine,
    ...(mode ? [`MODE: ${mode}`] : []),
    ...extraLines,
  ];
  const payload = {
    session_id: sessionId,
    hook_event_name: "PreToolUse",
    tool_name: "Agent",
    tool_input: {
      subagent_type: "aiharness:quality-reviewer",
      description: `Review ${taskId}`,
      prompt: lines.join("\n"),
      ...(model !== undefined ? { model } : {}),
    },
  };
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(payload),
    encoding: "utf8",
  });
  const updated = r.stdout.trim()
    ? JSON.parse(r.stdout).hookSpecificOutput.updatedInput
    : null;
  return {
    status: r.status,
    updated,
    stdout: r.stdout,
    stderr: r.stderr,
    ticketFile,
    logFile: join(TMP_ROOT, sanitizePath(REPO), sessionId, "hooks.log"),
  };
};

const ORDINARY = {
  id: "TASK-001",
  files_to_modify: ["src/components/atomic-crm/contacts/ContactInputs.tsx"],
  schema_sensitive: false,
};
const TOUCHES_SUPABASE = {
  id: "TASK-001",
  files_to_modify: ["supabase/schemas/03_views.sql", "src/x.tsx"],
  schema_sensitive: false,
};
const FLAGGED = {
  id: "TASK-001",
  files_to_modify: ["src/components/atomic-crm/contacts/ContactInputs.tsx"],
  schema_sensitive: true,
};

describe("route-review-model", () => {
  test("an ordinary ticket is routed to sonnet", () => {
    const r = run({ ticket: ORDINARY });
    expect(r.status).toBe(0);
    expect(r.updated.model).toBe("sonnet");
    cleanup();
  });

  test("the rewrite keeps the rest of the dispatch intact", () => {
    const r = run({ ticket: ORDINARY });
    expect(r.updated.subagent_type).toBe("aiharness:quality-reviewer");
    expect(r.updated.prompt).toContain("TASK_ID: TASK-001");
    expect(r.updated.description).toBe("Review TASK-001");
    cleanup();
  });

  test("a ticket already on sonnet keeps its model and only gains the REVIEW_TIER line", () => {
    const r = run({ ticket: ORDINARY, model: "sonnet" });
    expect(r.updated.model).toBe("sonnet");
    expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
    cleanup();
  });

  test("a ticket touching supabase/ has model REMOVED, not set to opus", () => {
    // Removal, so a runtime ignoring `model` leaves the reviewer on its declared opus.
    const r = run({ ticket: TOUCHES_SUPABASE, model: "sonnet" });
    expect(r.updated).not.toHaveProperty("model");
    cleanup();
  });

  test("schema_sensitive alone is enough to keep the stronger model", () => {
    // The case this condition exists for had no SQL in its diff: a select on a
    // CHECK-constrained column, left clearable, could submit "".
    const r = run({ ticket: FLAGGED, model: "sonnet" });
    expect(r.updated).not.toHaveProperty("model");
    cleanup();
  });

  test("a schema-sensitive ticket with no model keeps it absent, and still gains REVIEW_TIER", () => {
    const r = run({ ticket: TOUCHES_SUPABASE });
    expect(r.updated).not.toHaveProperty("model");
    expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
    cleanup();
  });

  test("a nested supabase/ path counts, not only a top-level one", () => {
    const r = run({
      ticket: {
        files_to_modify: ["packages/db/supabase/schemas/01_tables.sql"],
      },
      model: "sonnet",
    });
    expect(r.updated).not.toHaveProperty("model");
    cleanup();
  });

  test("a path merely containing the word supabase does not count", () => {
    const r = run({
      ticket: { files_to_modify: ["src/providers/supabaseAdapter.ts"] },
    });
    expect(r.updated.model).toBe("sonnet");
    cleanup();
  });

  describe("the whole-feature and migration passes are never downgraded", () => {
    test.each([
      "feature-review",
      "feature-smoke",
      "migration-review",
      "review",
    ])("MODE: %s is left as dispatched", (mode) => {
      const r = run({ ticket: ORDINARY, mode });
      expect(r.stdout).toBe("");
      cleanup();
    });

    test("the feature review's own dispatch shape, where MODE: is inline, is left as dispatched", () => {
      // The orchestrator writes the mode inside the ROLE line, not on one of its own, so
      // a guard anchored to line start reads no mode at all and downgrades the pass it
      // exists to protect.
      const r = run({ ticket: ORDINARY, inlineMode: "feature-review" });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      cleanup();
    });
  });

  describe("fails open, in the expensive direction", () => {
    test("an unreadable ticket file leaves the dispatch alone", () => {
      const r = run({ ticket: undefined });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      cleanup();
    });

    test("a dispatch with no TICKET_FILE and no diff is left as dispatched", () => {
      // With neither input there is nothing to tier from, and the reviewer reads a
      // missing REVIEW_TIER line as hard: stamping one here would invent a difficulty.
      const r = run({ ticket: ORDINARY, omitTicketFile: true });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      cleanup();
    });

    test("a ticket-less dispatch whose diff is empty is left as dispatched", () => {
      // An empty diff is no signal, exactly as a missing one is: with no ticket beside
      // it there is still nothing to tier from, and `normal` would be invented.
      const r = run({
        omitTicketFile: true,
        simple: true,
        diff: { files: 0, lines: 0 },
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      cleanup();
    });

    test("a ticket that is not an object leaves the dispatch alone", () => {
      const dir = tmp();
      const f = join(dir, "TASK-001.json");
      writeFileSync(f, '"just a string"');
      const r = spawnSync("node", [HOOK], {
        input: JSON.stringify({
          session_id: "route-test-1",
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: {
            subagent_type: "quality-reviewer",
            prompt: `ROLE: quality-reviewer\nTASK_ID: TASK-001\nTICKET_FILE: ${f}`,
          },
        }),
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      cleanup();
    });

    test("a ticket with no files_to_modify and no flag is ordinary", () => {
      // Nothing says the database is involved.
      const r = run({ ticket: { id: "TASK-001" } });
      expect(r.updated.model).toBe("sonnet");
      cleanup();
    });
  });

  describe("only the reviewer is routed", () => {
    test.each(["aiharness:developer", "aiharness:merger", "aiharness:planner"])(
      "%s is untouched",
      (role) => {
        const dir = tmp();
        const f = join(dir, "TASK-001.json");
        writeFileSync(f, JSON.stringify(ORDINARY));
        const r = spawnSync("node", [HOOK], {
          input: JSON.stringify({
            session_id: "route-test-1",
            hook_event_name: "PreToolUse",
            tool_name: "Agent",
            tool_input: {
              subagent_type: role,
              prompt: `TASK_ID: TASK-001\nTICKET_FILE: ${f}`,
            },
          }),
          encoding: "utf8",
        });
        expect(r.status).toBe(0);
        expect(r.stdout).toBe("");
        cleanup();
      },
    );

    test("a bare role name is routed too, since dispatch identity can be either", () => {
      const dir = tmp();
      const f = join(dir, "TASK-001.json");
      writeFileSync(f, JSON.stringify(ORDINARY));
      const r = spawnSync("node", [HOOK], {
        input: JSON.stringify({
          session_id: "route-test-1",
          hook_event_name: "PreToolUse",
          tool_name: "Agent",
          tool_input: {
            subagent_type: "quality-reviewer",
            prompt: `TASK_ID: TASK-001\nTICKET_FILE: ${f}`,
          },
        }),
        encoding: "utf8",
      });
      expect(JSON.parse(r.stdout).hookSpecificOutput.updatedInput.model).toBe(
        "sonnet",
      );
      cleanup();
    });
  });

  describe("tiers", () => {
    const TRIVIAL_SC = { risk: 1, coupling: 1, confidence: 9, testability: 1 };
    const HARD_SC = { risk: 7, coupling: 1, confidence: 9, testability: 1 };

    test("a trivial scorecard and a small diff route to the trivial tier's model, and stamp REVIEW_TIER", () => {
      const r = run({
        ticket: { ...ORDINARY, scorecard: TRIVIAL_SC },
        diff: { files: 1, lines: 3 },
      });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: trivial$/m);
      cleanup();
    });

    test("a ticket with no scorecard is normal, never trivial", () => {
      // A missing input is not evidence of an easy ticket. Floored at normal, the review
      // is no weaker than the untiered one it replaced, and the floor is invisible in the
      // routing log because trivial and normal share a model.
      const r = run({ ticket: ORDINARY, diff: { files: 1, lines: 3 } });
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
      cleanup();
    });

    test("a ticket whose diff cannot be computed is normal, never trivial", () => {
      // exec() maps a signal-killed git to status 0, so an unanswerable diff can reach
      // here as {files: 0} rather than as an error; either way the signal is absent, and
      // an absent signal must not buy the cheapest review.
      const r = run({ ticket: { ...ORDINARY, scorecard: TRIVIAL_SC } });
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
      cleanup();
    });

    test("a hard scorecard removes the model even on a tiny diff", () => {
      const r = run({
        ticket: { ...ORDINARY, scorecard: HARD_SC },
        model: "sonnet",
        diff: { files: 1, lines: 3 },
      });
      expect(r.updated).not.toHaveProperty("model");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
      cleanup();
    });

    test("a big diff escalates a trivial scorecard to hard", () => {
      const r = run({
        ticket: { ...ORDINARY, scorecard: TRIVIAL_SC },
        model: "sonnet",
        diff: { files: 9, lines: 9 },
      });
      expect(r.updated).not.toHaveProperty("model");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
      cleanup();
    });

    test("a stored tier never drops: a ticket already hard stays hard on a small re-review", () => {
      const r = run({
        ticket: { ...ORDINARY, scorecard: TRIVIAL_SC, tier: "hard" },
        model: "sonnet",
        diff: { files: 1, lines: 1 },
      });
      expect(r.updated).not.toHaveProperty("model");
      cleanup();
    });

    test("the computed tier is written back into the ticket file", () => {
      const r = run({
        ticket: { ...ORDINARY, scorecard: TRIVIAL_SC },
        diff: { files: 9, lines: 9 },
      });
      expect(JSON.parse(readFileSync(r.ticketFile, "utf8")).tier).toBe("hard");
      cleanup();
    });

    test("no scorecard and no git: normal, sonnet, and the log says both were missing", () => {
      const r = run({
        ticket: ORDINARY,
        sessionId: "ab12cd34-2222-2222-2222-222222222222",
      });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
      expect(readFileSync(r.logFile, "utf8")).toContain(
        "scorecard=none diff=none",
      );
      cleanup();
    });

    test("the diff base comes from the session id, not from BRANCH_NAME", () => {
      // The orchestrator's per-ticket reviewer dispatch carries no BRANCH_NAME, so a base
      // read only from that line leaves the diff tiering inert in production.
      const r = run({
        ticket: ORDINARY,
        diff: { files: 9, lines: 9 },
        omitBranchName: true,
      });
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
      cleanup();
    });

    test("an empty committed diff does not lower the tier, and reads as empty in the log", () => {
      const r = run({
        ticket: ORDINARY,
        diff: { files: 0, lines: 0 },
        sessionId: "ab12cd34-1111-1111-1111-111111111111",
      });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
      // "empty" and "none" are different facts: a diff that was read and was empty
      // cannot be told from a diff that was never read once the log says "none".
      expect(readFileSync(r.logFile, "utf8")).toContain("diff=empty");
      cleanup();
    });

    test("schema-sensitive is at least hard, as before", () => {
      const r = run({
        ticket: { ...TOUCHES_SUPABASE, scorecard: TRIVIAL_SC },
        model: "sonnet",
        diff: { files: 1, lines: 1 },
      });
      expect(r.updated).not.toHaveProperty("model");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
      cleanup();
    });

    test("a SIMPLE review, which has no ticket, is tiered from its own diff", () => {
      const r = run({
        omitTicketFile: true,
        simple: true,
        diff: { files: 9, lines: 9 },
      });
      expect(r.updated).not.toHaveProperty("model");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
      cleanup();
    });

    test("a small SIMPLE review is trivial and goes to sonnet", () => {
      const r = run({
        omitTicketFile: true,
        simple: true,
        diff: { files: 1, lines: 2 },
      });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: trivial$/m);
      cleanup();
    });

    test("a SIMPLE review is tiered from the session branch, not from the anchor behind it", () => {
      // Every worktree, the simple one included, is cut from session/<short>, so the
      // range under review is its own work. Tiering from session-base/<short> instead
      // would charge this one-file change for every wave the session had already merged,
      // and any supabase/ path among them would pin it to hard for the rest of the
      // session.
      const r = run({
        omitTicketFile: true,
        simple: true,
        model: "sonnet",
        diff: {
          files: 1,
          lines: 1,
          alreadyOnSession: {
            files: 9,
            paths: ["supabase/schemas/01_tables.sql"],
          },
        },
      });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: trivial$/m);
      cleanup();
    });

    test("a SIMPLE diff touching supabase/ is at least hard, with no ticket to say so", () => {
      // isSchemaSensitive reads the ticket's files_to_modify, and a SIMPLE review has no
      // ticket, so without the diff's own paths a one-file RLS change would tier trivial.
      const r = run({
        omitTicketFile: true,
        simple: true,
        model: "sonnet",
        diff: { files: 1, lines: 1, paths: ["supabase/schemas/01_tables.sql"] },
      });
      expect(r.updated).not.toHaveProperty("model");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
      cleanup();
    });

    test("the same two-file SIMPLE diff without a supabase/ path stays trivial", () => {
      const r = run({
        omitTicketFile: true,
        simple: true,
        model: "sonnet",
        diff: { files: 1, lines: 1, paths: ["src/lib/x.tsx"] },
      });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: trivial$/m);
      cleanup();
    });

    test("an existing REVIEW_TIER line is replaced, not duplicated", () => {
      const r = run({
        ticket: { ...ORDINARY, scorecard: HARD_SC },
        extraLines: ["REVIEW_TIER: trivial"],
      });
      expect(r.updated.prompt.match(/^REVIEW_TIER:/gm)).toHaveLength(1);
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: hard$/m);
      cleanup();
    });
  });
});
