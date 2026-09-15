// Tests for route-review-model: the per-ticket review model, decided by the harness.
//
// What matters is not the rule but the two things that make enforcing it safe: the
// asymmetric direction of each rewrite (SET sonnet, REMOVE model), and fail-open in the
// expensive direction.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
 * A worktree with a `session/ab12cd34` branch at the seed commit, and `files` more
 * files (of `lines` lines each) committed on top, for the diff-driven tier tests.
 */
const gitRepo = (dir, { files = 1, lines = 1 } = {}) => {
  const g = (...a) => spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  writeFileSync(join(dir, "seed.txt"), "seed\n");
  g("add", "-A");
  g("commit", "-qm", "seed");
  g("branch", "session/ab12cd34");
  for (let i = 0; i < files; i++) {
    writeFileSync(
      join(dir, `f${i}.txt`),
      Array.from({ length: lines }, (_, k) => `l${k}`).join("\n") + "\n",
    );
  }
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
  taskId = "TASK-001",
  omitTicketFile,
  diff,
  extraLines = [],
  sessionId = "ab12cd34-0000-0000-0000-000000000000",
} = {}) => {
  const dir = tmp();
  const ticketFile = join(dir, `${taskId}.json`);
  if (ticket !== undefined) writeFileSync(ticketFile, JSON.stringify(ticket));
  if (diff) gitRepo(dir, diff);
  const lines = [
    "ROLE: quality-reviewer",
    `TASK_ID: ${taskId}`,
    ...(omitTicketFile ? [] : [`TICKET_FILE: ${ticketFile}`]),
    `WORKTREE_PATH: ${dir}`,
    ...(diff ? ["BRANCH_NAME: ab12cd34/TASK-001"] : []),
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
    test.each(["feature-review", "feature-smoke", "migration-review"])(
      "MODE: %s is left as dispatched",
      (mode) => {
        const r = run({ ticket: ORDINARY, mode });
        expect(r.stdout).toBe("");
        cleanup();
      },
    );
  });

  describe("fails open, in the expensive direction", () => {
    test("an unreadable ticket file leaves the dispatch alone", () => {
      const r = run({ ticket: undefined });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
      cleanup();
    });

    test("a dispatch with no TICKET_FILE and no session branch is stamped normal and routed to sonnet", () => {
      const r = run({ ticket: ORDINARY, omitTicketFile: true });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
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
      const r = run({ ticket: ORDINARY });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
      cleanup();
    });

    test("an empty committed diff does not lower the tier", () => {
      const r = run({ ticket: ORDINARY, diff: { files: 0, lines: 0 } });
      expect(r.updated.model).toBe("sonnet");
      expect(r.updated.prompt).toMatch(/^REVIEW_TIER: normal$/m);
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
