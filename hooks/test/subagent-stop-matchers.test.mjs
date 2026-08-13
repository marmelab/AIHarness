// The SubagentStop matcher contract, pinned against MEASURED runtime semantics.
//
// Measured with a throwaway probe project (one hook group per matcher shape, each
// appending the payload's agent_type to a file) under Claude Code 2.1.227:
//
//   agent_type      matcher "planner"  "developer|planner"  ".*"  "*"  (omitted)  "(x:)?planner"
//   planner              FIRED              FIRED           FIRED FIRED  FIRED       FIRED
//   xplanner           not fired          not fired         FIRED FIRED  FIRED       FIRED
//
// So a matcher of plain alphanumerics + `|,-_` is an EXACT match against the
// `|`-separated list (xplanner does not match `planner`), and one containing a regex
// metacharacter is an UNANCHORED RegExp (`(x:)?planner` matches xplanner).
//
// The consequence this file exists to prevent: a plugin install reports the NAMESPACED
// `agent_type` (`aiharness:quality-reviewer`), which no bare role token can ever match.
// Every SubagentStop hook was therefore skipped on every real stop of every plugin-only
// run — no review verdict recorded, no validation run, no worktree cleaned, and the
// orchestrator's own completion invariant never evaluated. Nothing failed loudly,
// because a hook that never runs writes no log line.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HOOKS_JSON = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks.json",
);

const groups = () =>
  JSON.parse(readFileSync(HOOKS_JSON, "utf8")).hooks.SubagentStop ?? [];

// Claude Code's documented matcher dispatch, as measured above.
const matcherSelects = (matcher, agentType) => {
  if (matcher === undefined || matcher === null || matcher === "") return true;
  if (/^[\w|,-]+$/.test(matcher))
    return matcher
      .split("|")
      .map((s) => s.trim())
      .includes(agentType);
  if (matcher === "*") return true;
  return new RegExp(matcher).test(agentType);
};

const ROLES = [
  "developer",
  "simple-developer",
  "test-writer",
  "quality-reviewer",
  "merger",
  "planner",
  "orchestrator",
];

describe("SubagentStop matchers select an agent whatever its namespace", () => {
  test("hooks.json declares at least one SubagentStop group", () => {
    expect(groups().length).toBeGreaterThan(0);
  });

  test.each(ROLES)(
    "every group runs for the plugin-namespaced aiharness:%s",
    (role) => {
      for (const g of groups()) {
        const cmds = (g.hooks ?? [])
          .map((h) => String(h.command).replace(/.*hooks\//, ""))
          .join(", ");
        expect(
          matcherSelects(g.matcher, `aiharness:${role}`),
          `matcher ${JSON.stringify(g.matcher)} (${cmds}) does not select aiharness:${role}`,
        ).toBe(true);
      }
    },
  );

  test.each(ROLES)("every group also runs for the bare %s", (role) => {
    for (const g of groups()) {
      expect(
        matcherSelects(g.matcher, role),
        `matcher ${JSON.stringify(g.matcher)} does not select ${role}`,
      ).toBe(true);
    }
  });

  test("a suffixed runtime name is selected too", () => {
    for (const g of groups()) {
      expect(matcherSelects(g.matcher, "developer-TASK-001")).toBe(true);
      expect(matcherSelects(g.matcher, "aiharness:developer-TASK-001")).toBe(
        true,
      );
    }
  });

  test("an identity-less stop still reaches every group", () => {
    for (const g of groups()) {
      expect(matcherSelects(g.matcher, "")).toBe(true);
    }
  });
});

describe("the measured matcher semantics themselves", () => {
  test("a bare role token is an exact match, so it misses a namespaced agent", () => {
    expect(matcherSelects("quality-reviewer", "quality-reviewer")).toBe(true);
    expect(matcherSelects("quality-reviewer", "aiharness:quality-reviewer")).toBe(
      false,
    );
  });

  test("a pipe-separated role list is an exact-match list, not a substring test", () => {
    expect(matcherSelects("developer|planner", "planner")).toBe(true);
    expect(matcherSelects("developer|planner", "xplanner")).toBe(false);
    expect(matcherSelects("developer|planner", "aiharness:developer")).toBe(
      false,
    );
  });

  test("a metacharacter routes the matcher through an unanchored regex", () => {
    expect(matcherSelects("(aiharness:)?planner", "xplanner")).toBe(true);
    expect(matcherSelects(".*", "aiharness:anything-at-all")).toBe(true);
  });
});
