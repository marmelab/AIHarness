// Tests for render-status.mjs: the SubagentStop hook that renders a portable
// harness board (STATUS.md / TICKETS.md / status.json) under <REPO>/.harness/<short>
// from the session's cheap state. Uses APP_DIR + HARNESS_TMP_ROOT so the hook
// reads a throwaway repo and a fake session dir, same pattern as the other tests.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "render-status.mjs");
const SESSION_ID = "cafe1234-1111-2222-3333-444455556666";
const SHORT = SESSION_ID.split("-")[0];
const sanitize = (p) => p.replace(/\//g, "_");

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

// A throwaway repo + a fake session dir populated with the sources the hook reads:
// a technical progress log (the gate), two tickets, one review flag, one live
// worktree dir. `run()` fires the SubagentStop hook.
const setup = ({ withProgressLog = true } = {}) => {
  TMP = mkdtempSync(join(tmpdir(), "render-status-test-"));
  const app = join(TMP, "app");
  const tmpRoot = join(TMP, "wtroot");
  const base = join(tmpRoot, sanitize(app), SESSION_ID);
  mkdirSync(join(base, "tickets"), { recursive: true });
  mkdirSync(join(base, "reviews"), { recursive: true });
  mkdirSync(app, { recursive: true });

  if (withProgressLog) {
    writeFileSync(
      join(base, "harness-progress.log"),
      "12:00:01 plan ready (2 tickets)\n12:03:11 TASK-001 developer DONE\n12:05:42 TASK-001 merged\n",
    );
  }
  writeFileSync(
    join(base, "tickets", "TASK-001.json"),
    JSON.stringify({
      id: "TASK-001",
      title: "Rename the Add contact button",
      status: "merged",
      acceptance_criteria: ["button reads New contact"],
      files_to_modify: ["src/contacts/Button.tsx"],
      dependencies: [],
    }),
  );
  writeFileSync(
    join(base, "tickets", "TASK-002.json"),
    JSON.stringify({
      id: "TASK-002",
      title: "Add a Last activity column",
      status: "planned",
      acceptance_criteria: ["column visible", "sorted desc"],
      files_to_modify: ["src/contacts/List.tsx"],
      dependencies: ["TASK-001"],
    }),
  );
  // TASK-001 reviewed (flag present); TASK-002 still in flight (live worktree).
  writeFileSync(join(base, "reviews", "TASK-001-quality-reviewer"), "");
  mkdirSync(join(base, "TASK-002"), { recursive: true });

  const env = { ...process.env, APP_DIR: app, HARNESS_TMP_ROOT: tmpRoot };
  delete env.CHAT_SESSION_DIR;
  delete env.TICKETS_DIR;
  const run = (extraEnv = {}) =>
    spawnSync("node", [HOOK], {
      input: JSON.stringify({ session_id: SESSION_ID }),
      env: { ...env, ...extraEnv },
      encoding: "utf8",
    });
  const outDir = join(app, ".harness", SHORT);
  return { app, base, outDir, run };
};

describe("render-status", () => {
  test("renders STATUS.md with ticket table, verdict and live worktree", () => {
    const { outDir, run } = setup();
    const r = run();
    expect(r.status).toBe(0);
    const md = readFileSync(join(outDir, "STATUS.md"), "utf8");
    expect(md).toContain(SHORT);
    expect(md).toContain("1/2 merged");
    expect(md).toContain("TASK-001");
    expect(md).toContain("merged");
    expect(md).toContain("✅"); // TASK-001 review flag present
    expect(md).toContain("TASK-002");
    // TASK-002 has a live worktree dir → shown as in flight.
    expect(md).toContain("`TASK-002`");
    // The recent-activity block echoes the progress log.
    expect(md).toContain("TASK-001 merged");
    // No e2e verdict on disk yet: say so rather than imply the suite is green.
    expect(md).toContain("## End-of-feature e2e");
    expect(md).toContain("_not run this round_");
  });

  // This hook fires on EVERY subagent stop, and the render costs a git diff per dev
  // branch, so a stop that changed nothing must not render. The skip is what keeps a
  // session's stops from each paying for that.
  describe("re-render skip", () => {
    test("a second stop with nothing changed renders nothing new", () => {
      const { base, outDir, run } = setup();
      run();
      const first = statSync(join(outDir, "STATUS.md")).mtimeMs;
      const stored = JSON.parse(
        readFileSync(join(outDir, "status.json"), "utf8"),
      ).renderKey;
      expect(stored).toBeTruthy();

      const r = run();
      expect(r.status).toBe(0);
      expect(statSync(join(outDir, "STATUS.md")).mtimeMs).toBe(first);
      // And it says nothing: one line per stop reporting that nothing changed is the
      // same noise the render itself was. The first run logged once, so the count is
      // what must not grow.
      const lines = () =>
        readFileSync(join(base, "hooks.log"), "utf8")
          .split("\n")
          .filter((l) => l.includes("[render-status]")).length;
      expect(lines()).toBe(1);
      run();
      expect(lines()).toBe(1);
    });

    test("an appended progress line renders again", () => {
      const { base, outDir, run } = setup();
      run();
      const before = readFileSync(join(outDir, "STATUS.md"), "utf8");
      appendFileSync(
        join(base, "harness-progress.log"),
        "12:09:00 TASK-002 developer DONE\n",
      );
      run();
      const after = readFileSync(join(outDir, "STATUS.md"), "utf8");
      expect(after).not.toBe(before);
      expect(after).toContain("TASK-002 developer DONE");
    });

    // The key is stored in the board's own status.json, so a board that was never
    // written (or was deleted) renders rather than trusting a stale marker.
    test("a missing status.json renders again", () => {
      const { outDir, run } = setup();
      run();
      rmSync(join(outDir, "status.json"));
      run();
      expect(existsSync(join(outDir, "status.json"))).toBe(true);
    });

    // The stops that move NO progress line are exactly the ones these columns exist for:
    // quality-reviewer and merger both run with `validate: false`, so nothing appends for
    // them. Keying the skip on the log alone left the board showing the state from before
    // the review and before the cleanup, for the rest of the session.
    describe("a source other than the progress log moved", () => {
      const row = (outDir, id) =>
        readFileSync(join(outDir, "STATUS.md"), "utf8")
          .split("\n")
          .find((l) => l.startsWith(`| ${id} `)) ?? "";

      test("a review flag written by a reviewer's stop renders the ✅", () => {
        const { base, outDir, run } = setup();
        run();
        expect(row(outDir, "TASK-002")).not.toContain("✅");
        writeFileSync(join(base, "reviews", "TASK-002-quality-reviewer"), "");
        run();
        expect(row(outDir, "TASK-002")).toContain("✅");
      });

      test("a worktree removed at merge leaves the board", () => {
        const { base, outDir, run } = setup();
        run();
        expect(readFileSync(join(outDir, "STATUS.md"), "utf8")).toContain(
          "`TASK-002`",
        );
        rmSync(join(base, "TASK-002"), { recursive: true, force: true });
        run();
        expect(readFileSync(join(outDir, "STATUS.md"), "utf8")).not.toContain(
          "`TASK-002`",
        );
      });

      test("an e2e verdict written after the feature review reaches the board", () => {
        const { base, outDir, run } = setup();
        run();
        writeFileSync(
          join(base, "e2e-result.json"),
          JSON.stringify({ kind: "e2e-result", status: "failed" }),
        );
        run();
        expect(readFileSync(join(outDir, "STATUS.md"), "utf8")).toContain(
          "❌ **failed**",
        );
      });

      test("a ticket status change renders, though the dir listing is unchanged", () => {
        const { base, outDir, run } = setup();
        run();
        writeFileSync(
          join(base, "tickets", "TASK-002.json"),
          JSON.stringify({ id: "TASK-002", title: "x", status: "merged" }),
        );
        run();
        expect(readFileSync(join(outDir, "STATUS.md"), "utf8")).toContain(
          "2/2 merged",
        );
      });
    });
  });

  test("surfaces a red end-of-feature e2e on the board", () => {
    const { base, outDir, run } = setup();
    writeFileSync(
      join(base, "e2e-result.json"),
      JSON.stringify({ kind: "e2e-result", status: "failed" }),
    );
    run();
    const md = readFileSync(join(outDir, "STATUS.md"), "utf8");
    expect(md).toContain("❌ **failed**");
  });

  test("renders TICKETS.md with full per-ticket detail", () => {
    const { outDir, run } = setup();
    run();
    const md = readFileSync(join(outDir, "TICKETS.md"), "utf8");
    expect(md).toContain("## TASK-002 · Add a Last activity column");
    expect(md).toContain("column visible");
    expect(md).toContain("src/contacts/List.tsx");
    expect(md).toContain("Depends on:** TASK-001");
  });

  describe("criteria and open questions on the plan-gate board", () => {
    test("a derived criterion is marked on the board, a request one is not", () => {
      const { base, outDir, run } = setup();
      writeFileSync(
        join(base, "tickets", "TASK-003.json"),
        JSON.stringify({
          id: "TASK-003",
          title: "Mixed criteria",
          status: "planned",
          acceptance_criteria: [
            { text: "from the ask", source: "request" },
            { text: "my judgement", source: "derived" },
          ],
        }),
      );
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      expect(tickets).toMatch(/^ {2}- \[derived\] my judgement$/m);
      expect(tickets).toMatch(/^ {2}- from the ask$/m);
    });

    test("open questions are listed with their grade", () => {
      const { base, outDir, run } = setup();
      writeFileSync(
        join(base, "tickets", "TASK-003.json"),
        JSON.stringify({
          id: "TASK-003",
          title: "Ticket with open questions",
          status: "planned",
          open_questions: [{ id: "Q1", question: "persist?", grade: "arch" }],
        }),
      );
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      expect(tickets).toMatch(/^ {2}open questions:$/m);
      expect(tickets).toMatch(/^ {2}- \[arch\] persist\?$/m);
    });

    test("legacy string criteria render unchanged, with no marker", () => {
      const { base, outDir, run } = setup();
      writeFileSync(
        join(base, "tickets", "TASK-003.json"),
        JSON.stringify({
          id: "TASK-003",
          title: "Legacy ticket",
          status: "planned",
          acceptance_criteria: ["plain line"],
        }),
      );
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      expect(tickets).toMatch(/^ {2}- plain line$/m);
      expect(tickets).not.toMatch(/\[request\]/);
    });

    // The count exists so a human sees a malformed ticket at the gate instead of at
    // merge time, so it must render, not just be tracked internally.
    test("unreadable criteria rows are surfaced as a drop count", () => {
      const { base, outDir, run } = setup();
      writeFileSync(
        join(base, "tickets", "TASK-003.json"),
        JSON.stringify({
          id: "TASK-003",
          title: "Ticket with malformed rows",
          status: "planned",
          acceptance_criteria: [
            { text: "keep this", source: "request" },
            { source: "derived" },
            "",
          ],
        }),
      );
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      expect(tickets).toMatch(
        /^ {2}- 2 criteria row\(s\) unreadable, check the ticket JSON$/m,
      );
    });

    // What the human decided at the gate is the one thing on the board nobody else can
    // reconstruct: without it the decision lives only in the chat the developer and the
    // reviewer never read.
    test("questions decided at the gate are rendered with their answer", () => {
      const { base, outDir, run } = setup();
      writeFileSync(
        join(base, "tickets", "TASK-003.json"),
        JSON.stringify({
          id: "TASK-003",
          title: "Ticket with a decision",
          status: "planned",
          grill: [
            {
              id: "Q1",
              question: "persist?",
              answer: "no, transient",
              status: "answered",
            },
          ],
        }),
      );
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      expect(tickets).toMatch(/^ {2}decided at the gate:$/m);
      expect(tickets).toMatch(/^ {2}- persist\? -> no, transient$/m);
    });

    // Half a decision says nothing, and the board is not the place to find that out: this
    // is what keeps the render on the library's drop discipline rather than on t.grill raw.
    test("a decision missing its answer stays off the board", () => {
      const { base, outDir, run } = setup();
      writeFileSync(
        join(base, "tickets", "TASK-003.json"),
        JSON.stringify({
          id: "TASK-003",
          title: "Ticket with half a decision",
          status: "planned",
          grill: [
            { id: "Q1", question: "persist?" },
            { id: "Q2", question: "case-insensitive?", answer: "yes" },
          ],
        }),
      );
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      expect(tickets).toMatch(/^ {2}- case-insensitive\? -> yes$/m);
      expect(tickets).not.toMatch(/persist\?/);
    });

    test("a ticket with nothing decided renders no decided block", () => {
      const { outDir, run } = setup();
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      expect(tickets).not.toMatch(/decided at the gate/);
    });

    // The four blocks are what a ticket shows at the gate, and they share one indent
    // level: read together they must still say which line belongs to which block.
    test("criteria, drops, open questions and decisions read in that order", () => {
      const { base, outDir, run } = setup();
      writeFileSync(
        join(base, "tickets", "TASK-003.json"),
        JSON.stringify({
          id: "TASK-003",
          title: "Ticket with everything",
          status: "planned",
          acceptance_criteria: [
            { text: "from the ask", source: "request" },
            { text: "my judgement", source: "derived" },
            { source: "derived" },
          ],
          open_questions: [
            { id: "Q2", question: "still open?", grade: "arch" },
          ],
          grill: [{ id: "Q1", question: "persist?", answer: "no" }],
        }),
      );
      run();
      const tickets = readFileSync(join(outDir, "TICKETS.md"), "utf8");
      const at = (re) => tickets.search(re);
      expect(at(/^ {2}- \[derived\] my judgement$/m)).toBeGreaterThan(-1);
      expect(at(/^ {2}- 1 criteria row\(s\) unreadable/m)).toBeGreaterThan(
        at(/^ {2}- \[derived\] my judgement$/m),
      );
      expect(at(/^ {2}open questions:$/m)).toBeGreaterThan(
        at(/^ {2}- 1 criteria row\(s\) unreadable/m),
      );
      expect(at(/^ {2}decided at the gate:$/m)).toBeGreaterThan(
        at(/^ {2}- \[arch\] still open\?$/m),
      );
    });
  });

  test("writes status.json with correct counts and active tasks", () => {
    const { outDir, run } = setup();
    run();
    const s = JSON.parse(readFileSync(join(outDir, "status.json"), "utf8"));
    expect(s.short).toBe(SHORT);
    expect(s.tickets).toEqual({ total: 2, merged: 1, inProgress: 1 });
    expect(s.active).toEqual([{ task: "TASK-002" }]);
    expect(s.last).toContain("TASK-001 merged");
  });

  test("writes session.diff and a Changes section from the session branch", () => {
    const { app, outDir, run } = setup();
    // Turn the throwaway repo into a git repo with a session branch carrying one
    // change vs its fork anchor (session-base), like the harness topology.
    const g = (...a) =>
      spawnSync("git", ["-C", app, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    writeFileSync(join(app, "Button.tsx"), "label = 'Add contact'\n");
    g("add", ".");
    g("commit", "-qm", "base");
    g("branch", `session-base/${SHORT}`);
    g("checkout", "-q", "-b", `session/${SHORT}`);
    writeFileSync(join(app, "Button.tsx"), "label = 'New contact'\n");
    g("add", ".");
    g("commit", "-qm", "rename button");
    g("checkout", "-q", "main");

    run();
    const patch = readFileSync(join(outDir, "session.diff"), "utf8");
    expect(patch).toContain("Button.tsx");
    expect(patch).toContain("+label = 'New contact'");
    expect(patch).toContain("-label = 'Add contact'");
    const md = readFileSync(join(outDir, "STATUS.md"), "utf8");
    expect(md).toContain("## Changes");
    expect(md).toContain("Button.tsx");
  });

  test("includes in-flight dev-branch work before it is merged", () => {
    const { app, outDir, run } = setup();
    const g = (...a) =>
      spawnSync("git", ["-C", app, ...a], { encoding: "utf8" });
    g("init", "-q", "-b", "main");
    g("config", "user.email", "t@t.t");
    g("config", "user.name", "t");
    writeFileSync(join(app, "List.tsx"), "no filter\n");
    g("add", ".");
    g("commit", "-qm", "base");
    g("branch", `session-base/${SHORT}`);
    g("branch", `session/${SHORT}`); // session branch at fork, nothing merged yet
    // developer's in-flight branch, committed but NOT merged into the session
    g("checkout", "-q", "-b", `${SHORT}/TASK-001`);
    writeFileSync(join(app, "List.tsx"), "without-email filter\n");
    g("add", ".");
    g("commit", "-qm", "wip");
    g("checkout", "-q", "main");

    run();
    const patch = readFileSync(join(outDir, "session.diff"), "utf8");
    expect(patch).toContain(`in flight: ${SHORT}/TASK-001`);
    expect(patch).toContain("+without-email filter");
  });

  test("omits session.diff when there is no git session branch", () => {
    const { outDir, run } = setup();
    run();
    expect(existsSync(join(outDir, "session.diff"))).toBe(false);
    const md = readFileSync(join(outDir, "STATUS.md"), "utf8");
    expect(md).toContain("no changes yet");
  });

  test("is inert when there is no technical progress log", () => {
    const { app, run } = setup({ withProgressLog: false });
    const r = run();
    expect(r.status).toBe(0);
    expect(existsSync(join(app, ".harness"))).toBe(false);
  });

  test("is a no-op under a managed launcher (CHAT_SESSION_DIR set)", () => {
    const { app, run } = setup();
    const r = run({ CHAT_SESSION_DIR: "/tmp/managed-session-xyz" });
    expect(r.status).toBe(0);
    expect(existsSync(join(app, ".harness"))).toBe(false);
  });
});
