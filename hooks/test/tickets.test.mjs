// Tests for lib/tickets.mjs ticketDirs: the one list of where a session's tickets live.
//
// Four readers key on it, and one more consumer cannot: skills/plan-grill/SKILL.md runs in
// the MAIN thread, so it cannot import this module and carries the same three locations as
// prose. That copy is what the last describe block pins. The drift worth catching is the
// library adding, dropping or reordering a location while the skill keeps looking in the
// old ones, which is how a grill silently reports an all-clear over a plan it never found.

import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";
import { ticketDirs } from "../lib/tickets.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

const TMP = mkdtempSync(join(tmpdir(), "ticket-dirs-"));
const SESSION = "13afe5d3-e162-4b8b-9948-74d79e50ec15";
const SESSION_DIR = join(TMP, "session");
const SCRATCH_PARENT = join(TMP, "claude-1000", "-workspaces-app", SESSION);
mkdirSync(join(SCRATCH_PARENT, "scratchpad"), { recursive: true });
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const ctx = {
  ticketsDir: join(SESSION_DIR, "tickets"),
  sessionDir: SESSION_DIR,
  sessionId: SESSION,
};

describe("ticketDirs", () => {
  test("tries the tickets dir, then the session dir, then the scratchpad parent", () => {
    expect(ticketDirs(ctx, TMP)).toEqual([
      join(SESSION_DIR, "tickets"),
      SESSION_DIR,
      SCRATCH_PARENT,
    ]);
  });

  test("the two known dirs answer when no scratchpad exists", () => {
    expect(ticketDirs(ctx, join(TMP, "absent"))).toEqual([
      join(SESSION_DIR, "tickets"),
      SESSION_DIR,
    ]);
  });

  // Reading a session id is what throws when there is none, and a reader that cannot name
  // its session must still get the paths it does know rather than an exception.
  test("a ctx whose session id throws still yields the two known dirs", () => {
    const noId = {
      ticketsDir: join(SESSION_DIR, "tickets"),
      sessionDir: SESSION_DIR,
      get sessionId() {
        throw new Error("no session id");
      },
    };
    expect(() => ticketDirs(noId, TMP)).not.toThrow();
    expect(ticketDirs(noId, TMP)).toEqual([
      join(SESSION_DIR, "tickets"),
      SESSION_DIR,
    ]);
  });
});

// The skill cannot import ticketDirs, so the list is duplicated in prose and nothing but
// this ties the two together. Matched on the distinguishing part of each location rather
// than on a whole sentence, so rewording the skill does not fail the test and dropping a
// location does.
describe("the plan-grill skill's copy of the same three locations", () => {
  const skill = readFileSync(
    join(HERE, "..", "..", "skills", "plan-grill", "SKILL.md"),
    "utf8",
  );

  // The section, then the numbered list inside it: prose is allowed between the heading
  // and the list, and the search must not wander into a later section's list.
  const inputSection = () =>
    skill.split(/^## /m).find((part) => part.startsWith("1. Input\n")) ?? null;

  const listedLocations = () => {
    const section = inputSection();
    if (!section) return null;
    // Past the heading line, which is itself numbered and would read as a location.
    const body = section.slice(section.indexOf("\n") + 1);
    return [...body.matchAll(/^\d+\.\s+(.*)$/gm)].map((m) => m[1]);
  };

  test("is still where the reader can find it", () => {
    // A failure here means SKILL.md renamed or moved its Input section, not that the list
    // is wrong: re-anchor this match on the new heading.
    expect(inputSection()).not.toBeNull();
  });

  // One row per location ticketDirs returns, in the order it tries them.
  const LOCATIONS = [
    ["the tickets dir the coordinator names", /TICKETS_DIR/],
    ["the session dir itself", /session dir/i],
    ["the runtime scratchpad's parent", /scratchpad/i],
  ];

  test("names exactly as many locations as ticketDirs returns", () => {
    const listed = listedLocations();
    // Guarded, not assumed: a missing section is the test above's failure, and reading
    // through it here would bury that one under a TypeError.
    expect(listed).not.toBeNull();
    expect(listed).toHaveLength(ticketDirs(ctx, TMP).length);
    expect(listed).toHaveLength(LOCATIONS.length);
  });

  test.each(LOCATIONS)("names %s, in ticketDirs' own order", (_label, re) => {
    const listed = listedLocations();
    expect(listed).not.toBeNull();
    const at = LOCATIONS.findIndex(([, r]) => r === re);
    expect(listed[at]).toMatch(re);
  });
});
