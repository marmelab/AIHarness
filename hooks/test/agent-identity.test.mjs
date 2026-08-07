// Tests for role identity, in lib/teams.mjs.
//
// A plugin-provided agent arrives NAMESPACED: the runtime reports `aiharness:developer`,
// not `developer`. A predicate anchored on the bare role returns false for it, which turns a
// whole family of guards inert at once: bash-guard stops gating validation commands for
// developers and reviewers, record-review-verdict stops recording verdicts,
// completion-invariant stops recognising the orchestrator's stop.
//
// None of that fails loudly, because each of those guards treats "not my role" as "not my
// business". So every case here passes BOTH forms: a suite that only ever passes bare role
// names cannot see the namespaced form break identity.

import { describe, expect, test } from "vitest";
import {
  bareRole,
  isDeveloper,
  isMerger,
  isOrchestrator,
  isQualityReviewer,
} from "../lib/teams.mjs";

describe("bareRole", () => {
  test.each([
    ["aiharness:developer", "developer"],
    ["aiharness:quality-reviewer", "quality-reviewer"],
    ["some-other.plugin:merger", "merger"],
    ["developer", "developer"],
    ["developer-TASK-001", "developer-TASK-001"],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(bareRole(input)).toBe(expected);
  });

  test("undefined and null are empty, never a crash", () => {
    expect(bareRole(undefined)).toBe("");
    expect(bareRole(null)).toBe("");
  });

  // A TASK suffix carries a colon nowhere, so only the leading prefix is stripped.
  test("strips only the leading namespace", () => {
    expect(bareRole("aiharness:developer-TASK-003")).toBe("developer-TASK-003");
  });
});

describe("role predicates accept both the bare and the namespaced form", () => {
  const cases = [
    [
      isDeveloper,
      [
        "developer",
        "aiharness:developer",
        "developer-TASK-001",
        "aiharness:developer-TASK-001",
      ],
    ],
    [
      isQualityReviewer,
      [
        "quality-reviewer",
        "aiharness:quality-reviewer",
        "quality-reviewer-TASK-002",
      ],
    ],
    [isMerger, ["merger", "aiharness:merger", "merger-TASK-003"]],
    [
      isOrchestrator,
      [
        "orchestrator",
        "aiharness:orchestrator",
        "chat-orchestrator",
        "orchestrator-abc",
      ],
    ],
  ];

  for (const [predicate, names] of cases) {
    test.each(names)(`${predicate.name} matches %s`, (name) => {
      expect(predicate(name)).toBe(true);
    });
  }
});

describe("role predicates still reject what is not their role", () => {
  test("a different role, namespaced or not", () => {
    expect(isDeveloper("aiharness:merger")).toBe(false);
    expect(isMerger("aiharness:developer")).toBe(false);
    expect(isOrchestrator("aiharness:planner")).toBe(false);
    expect(isQualityReviewer("aiharness:developer")).toBe(false);
  });

  // The boundary matters: a role name that merely STARTS with another role's name is not it.
  test("a prefix collision is not a match", () => {
    expect(isDeveloper("aiharness:developer-tools-agent")).toBe(true); // suffixed form, legitimately a developer
    expect(isMerger("aiharness:mergerbot")).toBe(false);
    expect(isOrchestrator("aiharness:orchestration-helper")).toBe(false);
  });

  test("empty identity matches nothing", () => {
    for (const p of [
      isDeveloper,
      isMerger,
      isOrchestrator,
      isQualityReviewer,
    ]) {
      expect(p("")).toBe(false);
      expect(p(undefined)).toBe(false);
    }
  });
});
