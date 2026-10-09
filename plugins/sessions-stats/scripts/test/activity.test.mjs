// Tests for the activity classifier, the thing that decides what a chart MEANS.
//
// A misfiled tool call does not fail anywhere: it silently moves minutes from one bar to
// another, and the conclusion drawn from the bar is wrong with no symptom. So the cases
// pinned here are the ones where a plausible-looking rule table would get it backwards.

import { describe, expect, test } from "vitest";
import {
  callDetail,
  callSummary,
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

  test("sed printing a range is a read, sed editing in place is not", () => {
    expect(bash("sed -n 40,80p src/a.ts")).toBe("explore");
    expect(bash("cd /wt && sed -n 1,20p a.ts; grep -n foo b.ts | head")).toBe(
      "explore",
    );
    expect(bash("sed -n -i 's/a/b/p' a.ts")).toBe("exec");
    expect(bash("sed -i 's/a/b/' a.ts")).toBe("exec");
    expect(bash("sed -n 1,5p a.ts | node transform.mjs")).toBe("exec");
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

describe("a call says what it did", () => {
  // The exact command is kept and shown on hover; this is the label that makes a table of
  // two hundred rows readable. It has to start from the VERB: truncating to the last
  // ninety characters is right for a path and useless for a command, and it showed the
  // tail of every pipeline — "…me_atomic-crm-demo --format '{{.State.StartedAt}}" names
  // nothing where "docker ps" does.
  const sum = (command) => callSummary("Bash", { command });

  test("the verb and its object, not the plumbing", () => {
    expect(sum("docker ps -a --filter \"name=x\" --format '{{.Names}}'")).toBe(
      "docker ps",
    );
    expect(sum("git -C /workspaces/app log --oneline -5")).toBe("git log");
    expect(sum("supabase db reset --linked")).toBe("supabase db reset");
  });

  test("two words of subcommand, because one is often only a noun", () => {
    // "gh pr" says nothing; "gh pr edit" does. A bare number is never the subcommand.
    expect(sum("gh pr edit 156 --add-label RFR")).toBe("gh pr edit");
    expect(sum("npm run test -- EmailSendSheet")).toBe("npm run test");
  });

  test("a prefix is not the command", () => {
    expect(sum("cd /wt && FOO=1 npm run build")).toBe("npm run build");
  });

  test("the pattern names a search, the file names an edit", () => {
    expect(sum('grep -E "FAIL|Error" out.txt')).toBe('grep "FAIL|Error"');
    expect(sum("sed -n 855,875p /a/b/EmailSendSheet.tsx")).toBe(
      "sed EmailSendSheet.tsx",
    );
  });

  test("a url is its host and path, without the scheme", () => {
    expect(
      sum(
        'curl -s -o /dev/null -w "%{http_code}" http://localhost:3100/index.html',
      ),
    ).toBe("curl localhost:3100/index.html");
  });

  test("an inline program is not quoted back at the reader", () => {
    expect(
      sum('python3 -c "import json,sys; print(json.load(sys.stdin))"'),
    ).toBe("python3 inline script");
  });

  test("a chain says how many commands it holds", () => {
    // Three commands chained is not one command, and the count is the only hint of it.
    expect(sum("ls -la $D; ls -la $D/* | head -20")).toMatch(/\+2$/);
    expect(sum("git status")).not.toMatch(/\+/);
  });

  test("a dispatch is named by what it was asked to do", () => {
    // The tool column already says Agent; "general-purpose" repeated forty times names
    // nothing.
    expect(
      callSummary("Agent", {
        subagent_type: "general-purpose",
        description: "Implement Task 1.7",
      }),
    ).toBe("Implement Task 1.7");
  });

  test("other tools are named by what they touched", () => {
    expect(callSummary("Read", { file_path: "/a/b/EmailSendSheet.tsx" })).toBe(
      "EmailSendSheet.tsx",
    );
    expect(callSummary("Skill", { skill: "ponytail" })).toBe("ponytail");
    expect(
      callSummary("mcp__plugin_playwright_playwright__browser_click", {}),
    ).toBe("browser_click");
  });

  test("a command keeps its head on hover, where a path keeps its tail", () => {
    // Opposite ends, for opposite reasons: a command is named by its verb, a file by its
    // basename.
    const cmd = "git log --oneline " + "x".repeat(500);
    expect(callDetail("Bash", { command: cmd }).startsWith("git log")).toBe(
      true,
    );
    const path = "/" + "d".repeat(300) + "/End.tsx";
    expect(callDetail("Read", { file_path: path }).endsWith("End.tsx")).toBe(
      true,
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
