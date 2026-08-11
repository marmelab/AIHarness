// Tests for check-view-column-order: a replaced view may only GAIN columns, at the end.
//
// The case that motivates all of this is the one three consecutive runs got wrong, and it
// is reproduced verbatim below: a new column inserted next to a semantically related one
// in `contacts_summary`. It typechecks, every test passes, and the deploy fails with
// PostgreSQL 42P16 — so the only signal that can arrive in time is this one.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "check-view-column-order.mjs",
);

let repo;
beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "view-order-"));
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  mkdirSync(join(repo, "supabase", "schemas"), { recursive: true });
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

const VIEW_BEFORE = `create or replace view contacts_summary as
select
  co.id,
  co.first_name,
  co.last_name,
  co.status,
  count(distinct t.id) filter (where t.done_date is null) as nb_tasks
from contacts co
left join tasks t on t.contact_id = co.id;
`;

/** Commit the file as HEAD, then write `after` on top and run the hook over it. */
const run = (before, after, name = "03_views.sql") => {
  const rel = `supabase/schemas/${name}`;
  const abs = join(repo, rel);
  writeFileSync(abs, before);
  const git = (...args) => execFileSync("git", args, { cwd: repo });
  git("add", "-A");
  git("commit", "-qm", "base");
  writeFileSync(abs, after);
  const payload = JSON.stringify({
    session_id: "test-1234",
    hook_event_name: "PostToolUse",
    tool_name: "Edit",
    tool_input: { file_path: abs },
    cwd: repo,
    transcript_path: "/dev/null",
  });
  try {
    execFileSync("node", [HOOK], { input: payload, encoding: "utf8" });
    return { flagged: false, message: "" };
  } catch (e) {
    return { flagged: true, message: String(e.stderr || "") };
  }
};

describe("check-view-column-order", () => {
  test("flags the column inserted mid-select, and names where it belongs", () => {
    const after = VIEW_BEFORE.replace(
      "  co.status,\n",
      "  co.status,\n  co.importance,\n",
    );
    const r = run(VIEW_BEFORE, after);
    expect(r.flagged).toBe(true);
    expect(r.message).toContain("contacts_summary");
    expect(r.message).toContain("importance");
    expect(r.message).toContain("42P16");
    // The remedy is the useful part: the order it should have had.
    expect(r.message).toContain("nb_tasks, importance");
  });

  test("accepts the same column appended last", () => {
    const after = VIEW_BEFORE.replace(
      "as nb_tasks\n",
      "as nb_tasks,\n  co.importance\n",
    );
    expect(run(VIEW_BEFORE, after).flagged).toBe(false);
  });

  test("accepts a view that did not change", () => {
    expect(run(VIEW_BEFORE, VIEW_BEFORE).flagged).toBe(false);
  });

  test("accepts a brand-new view, which has no order to preserve", () => {
    const after = `${VIEW_BEFORE}
create or replace view companies_summary as
select c.id, c.name, c.sector from companies c;
`;
    expect(run(VIEW_BEFORE, after).flagged).toBe(false);
  });

  test("ignores a migration file, where DROP and recreate is the sanctioned way", () => {
    const after = VIEW_BEFORE.replace(
      "  co.status,\n",
      "  co.status,\n  co.importance,\n",
    );
    const abs = join(repo, "supabase", "migrations");
    mkdirSync(abs, { recursive: true });
    const r = run(VIEW_BEFORE, after, "../migrations/0001_x.sql");
    expect(r.flagged).toBe(false);
  });

  test("ignores a file with no replaceable view", () => {
    const before = "create table contacts (id bigint primary key);\n";
    const after = "create table contacts (id bigint primary key, x text);\n";
    expect(run(before, after, "01_tables.sql").flagged).toBe(false);
  });

  test("flags a reordering even when nothing was added to the tail", () => {
    const after = VIEW_BEFORE.replace(
      "  co.first_name,\n  co.last_name,\n",
      "  co.last_name,\n  co.first_name,\n  co.importance,\n",
    );
    expect(run(VIEW_BEFORE, after).flagged).toBe(true);
  });
});
