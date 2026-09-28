// Tests for the activity classifier, the thing that decides what a chart MEANS.
//
// A misfiled tool call does not fail anywhere: it silently moves minutes from one bar to
// another, and the conclusion drawn from the bar is wrong with no symptom. So the cases
// pinned here are the ones where a plausible-looking rule table would get it backwards.

import { describe, expect, test } from "vitest";
import {
  callDetail,
  callPath,
  callSignature,
  loadRules,
  makeClassifier,
  validateCommandsFrom,
} from "../lib/activity.mjs";

const classify = makeClassifier();
const bash = (command) => classify("Bash", { command });

describe("tool mapping", () => {
  test("names map to their bucket", () => {
    expect(classify("Edit", { file_path: "a.ts" })).toBe("write");
    expect(classify("Read", { file_path: "a.ts" })).toBe("explore");
    expect(classify("Agent", { subagent_type: "developer" })).toBe("dispatch");
    expect(classify("Skill", { skill: "ponytail" })).toBe("skill");
  });

  test("an mcp tool falls to its prefix, playwright before the generic one", () => {
    expect(
      classify("mcp__plugin_playwright_playwright__browser_click", {}),
    ).toBe("runtime");
    expect(classify("mcp__claude_ai_Trello__trelloReadBoard", {})).toBe(
      "integration",
    );
  });

  test("an unknown tool lands in the fallback rather than in a real bucket", () => {
    expect(classify("SomeToolShippedNextMonth", {})).toBe("other");
  });
});

describe("bash", () => {
  test("exploration is exploration however it is wrapped", () => {
    expect(bash("grep -rn foo src/")).toBe("explore");
    // The prefix-stripping bash-classify already owns; re-deriving it here would give a
    // second, worse answer to the same question.
    expect(bash("cd /wt && L=x grep -rn foo src/")).toBe("explore");
  });

  test("a pipeline into a writer is not exploration", () => {
    expect(bash("grep -rn foo src/ | node transform.mjs")).toBe("exec");
  });

  test("validation beats the generic exec bucket", () => {
    expect(bash("npm run typecheck")).toBe("validate");
    expect(bash("npx vitest run src/foo.test.ts")).toBe("validate");
  });

  test("git plumbing is its own bucket, not exploration", () => {
    expect(bash("git diff --stat")).toBe("git");
    expect(bash("git -C /wt log --oneline -5")).toBe("git");
  });

  test("the progress log is bookkeeping, and it is matched before anything else", () => {
    // It is an append, so a naive rule table calls it `exec` and charges the harness's own
    // required bookkeeping as work.
    expect(bash('echo "12:00:00 planned" >> /s/harness-progress.log')).toBe(
      "bookkeeping",
    );
  });

  test("driving the app is runtime, even though it is a shell call", () => {
    expect(bash("curl -s http://localhost:5173/health")).toBe("runtime");
    expect(bash("npx playwright test")).toBe("runtime");
  });

  test("an empty command decides nothing rather than inventing a bucket", () => {
    expect(bash("   ")).toBe("other");
  });
});

describe("project validation commands", () => {
  const config = {
    validation: {
      steps: [
        { id: "typecheck", command: "make verify" },
        { id: "unit", runner: "vitest" },
        { id: "noop" },
      ],
    },
  };

  test("are read from harness.config.json rather than guessed", () => {
    expect(validateCommandsFrom(config)).toContain("make verify");
    expect(validateCommandsFrom(config)).toContain("vitest");
    expect(validateCommandsFrom(null)).toEqual([]);
  });

  test("catch a bespoke chain the generic regexes cannot know about", () => {
    const withProject = makeClassifier({
      validateCommands: validateCommandsFrom(config),
    });
    // Without the project's own list this is just `exec`: nothing in "make verify" says
    // validation, which is exactly why the hooks read the config instead of pattern
    // matching.
    expect(classify("Bash", { command: "make verify" })).toBe("exec");
    expect(withProject("Bash", { command: "cd /wt && make verify" })).toBe(
      "validate",
    );
  });
});

describe("call identity", () => {
  test("the same read twice has the same signature", () => {
    const a = callSignature("Read", { file_path: "/a.ts" });
    const b = callSignature("Read", { file_path: "/a.ts" });
    expect(a).toBe(b);
  });

  test("a different window of the same file is not the same call", () => {
    const whole = callSignature("Read", { file_path: "/a.ts" });
    const window = callSignature("Read", { file_path: "/a.ts", offset: 200 });
    expect(whole).not.toBe(window);
  });

  test("key order cannot invent a difference on an unknown tool", () => {
    const a = callSignature("Future", { b: 2, a: 1 });
    const b = callSignature("Future", { a: 1, b: 2 });
    expect(a).toBe(b);
  });
});

describe("labels", () => {
  test("a detail is a label, so a long path keeps its tail", () => {
    const detail = callDetail("Read", {
      file_path: "/" + "x".repeat(200) + "/end.ts",
    });
    expect(detail.startsWith("…")).toBe(true);
    expect(detail.endsWith("end.ts")).toBe(true);
  });

  test("a path is extracted only when the call touched exactly one", () => {
    expect(callPath("Read", { file_path: "/a.ts" })).toBe("/a.ts");
    expect(callPath("Grep", { pattern: "x" })).toBe(null);
  });
});

describe("the rule table", () => {
  test("is data, so a bucket can be added without touching code", () => {
    const rules = loadRules();
    rules.byTool.BrandNewTool = "runtime";
    const extended = makeClassifier({ rules });
    expect(extended("BrandNewTool", {})).toBe("runtime");
    expect(classify("BrandNewTool", {})).toBe("other");
  });
});
