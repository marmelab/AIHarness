// Tests for route-review-model: the per-ticket review model, decided by the harness.
//
// What matters is not the rule but the two things that make enforcing it safe: the
// asymmetric direction of each rewrite (SET sonnet, REMOVE model), and fail-open in the
// expensive direction.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
 * Run the guard on a reviewer dispatch for a ticket with the given fields.
 * @returns {{status: number, updated: object|null, stdout: string}}
 */
const run = ({
  ticket,
  model,
  mode,
  taskId = "TASK-001",
  omitTicketFile,
} = {}) => {
  const dir = tmp();
  const ticketFile = join(dir, `${taskId}.json`);
  if (ticket !== undefined) writeFileSync(ticketFile, JSON.stringify(ticket));
  const lines = [
    "ROLE: quality-reviewer",
    `TASK_ID: ${taskId}`,
    ...(omitTicketFile ? [] : [`TICKET_FILE: ${ticketFile}`]),
    `WORKTREE_PATH: ${dir}`,
    ...(mode ? [`MODE: ${mode}`] : []),
  ];
  const payload = {
    session_id: "route-test-1",
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
  return { status: r.status, updated, stdout: r.stdout, stderr: r.stderr };
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

  test("a ticket already on sonnet is left alone, with no rewrite emitted", () => {
    const r = run({ ticket: ORDINARY, model: "sonnet" });
    expect(r.stdout).toBe("");
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

  test("a schema-sensitive ticket with no model is already correct", () => {
    const r = run({ ticket: TOUCHES_SUPABASE });
    expect(r.stdout).toBe("");
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

    test("a dispatch with no TICKET_FILE line leaves the dispatch alone", () => {
      const r = run({ ticket: ORDINARY, omitTicketFile: true });
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
});
