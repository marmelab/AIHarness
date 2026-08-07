// Tests for the two PreToolUse dispatchers (pre-tool-bash, pre-tool-agent).
//
// The point of the refactor is that ONE process now does what seven or eight did, so
// the thing worth pinning is that it decides the same way. Each case is run twice: once
// through the dispatcher, once through the individual guards in the registered order,
// and the two verdicts must agree. That is what makes the merge reviewable: the guards
// were not re-read, they were re-run.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const hook = (name) => join(HERE, "..", `${name}.mjs`);

// The registered order, mirrored from hooks/hooks.json. A dispatcher that reordered its
// guards would still pass every individual hook test, so the order is pinned here.
const BASH_GUARDS = [
  "bash-guard",
  "pre-pr-checks",
  "block-docker-containers",
  "circuit-breaker",
  "block-orchestrator-merge",
  "block-wave-merger-promote",
  "restrict-documentator-bash",
];
const AGENT_GUARDS = [
  "block-nested-orchestrator",
  "block-duplicate-dispatch",
  "block-merger-without-review",
  "block-promote-unmerged",
  "record-merger-stage",
  "enforce-dev-dispatch",
  "force-foreground-orchestrator-dispatch",
  "setup-worktree",
];

let TMP, APP_DIR, sessionDir, env;
const SESSION_ID = "d15pa7ch-1111-2222-3333-444455556666";

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "pre-tool-dispatch-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  sessionDir = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(APP_DIR, { recursive: true });
  // The guards derive what they forbid from the CONSUMING project's config, so a
  // config-less fixture would silently make half of these cases vacuous: with no
  // validation steps declared, bash-guard forbids no validation command at all.
  writeFileSync(
    join(APP_DIR, "harness.config.json"),
    JSON.stringify({
      validation: {
        steps: [
          { id: "typecheck", kind: "typecheck", command: "npm run typecheck" },
        ],
        extraForbidden: ["build", "e2e"],
      },
      containers: { allow: [] },
      roles: {
        developer: { model: "sonnet", pipeline: true, debounce: true },
        "quality-reviewer": { model: "opus", pipeline: true, debounce: true },
        merger: { model: "haiku", pipeline: true, debounce: true },
        planner: { model: "opus", pipeline: true },
      },
    }),
  );
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.CLAUDE_AGENT_NAME;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CHAT_SESSION_DIR;
  delete env.DOCUMENTATOR_RUN;
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

const run = (path, payload, extraEnv = {}) =>
  spawnSync("node", [path], {
    input: JSON.stringify(payload),
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });

const verdict = (r) => {
  if (r.status === 2) return { kind: "fail", text: r.stderr };
  if (r.stdout.includes('"decision":"block"'))
    return { kind: "block", text: r.stdout };
  return { kind: "allow", text: "" };
};

// The chain as it used to be wired: one process per guard, first refusal wins.
const runSeparateGuards = (guards, payload, extraEnv = {}) => {
  for (const g of guards) {
    const v = verdict(run(hook(g), payload, extraEnv));
    if (v.kind !== "allow") return { guard: g, ...v };
  }
  return { guard: "", kind: "allow", text: "" };
};

// The two runs of one case must not see each other's markers: several guards record
// state on the way through (the dispatch debounce, the breaker counter), so replaying
// the same payload in the same session dir would refuse the replay as a duplicate and
// report a difference the guards did not actually have. A distinct session id per run
// gives each its own <tmp>/<repo>/<session> state.
const SEPARATE_SESSION = "5eparate-1111-2222-3333-444455556666";

describe("pre-tool-bash dispatcher", () => {
  const CASES = [
    [
      "a headed playwright run is refused",
      { agent_type: "", command: "npx playwright test --headed" },
      "block",
    ],
    [
      "a validation command from a developer is refused",
      { agent_type: "developer", command: "npm run typecheck" },
      "block",
    ],
    [
      "a bash file write is refused",
      { agent_type: "developer", command: "echo x > src/a.ts" },
      "block",
    ],
    [
      "an unlisted container launch is refused",
      { agent_type: "developer", command: "docker run -d redis" },
      "block",
    ],
    [
      "a plain read command is allowed",
      { agent_type: "developer", command: "git status" },
      "allow",
    ],
    [
      "a reviewer reading a diff is allowed",
      { agent_type: "quality-reviewer", command: "git -C /wt diff HEAD~1" },
      "allow",
    ],
  ];

  test.each(CASES)("%s, and identically either way", (_label, c, expected) => {
    const payload = {
      tool_name: "Bash",
      agent_type: c.agent_type,
      session_id: SESSION_ID,
      tool_input: { command: c.command },
    };
    const chained = verdict(run(hook("pre-tool-bash"), payload));
    const separate = runSeparateGuards(BASH_GUARDS, {
      ...payload,
      session_id: SEPARATE_SESSION,
    });
    // Assert the verdict, not only that the two agree: two identical "allow"s would
    // otherwise pass for a case meant to be refused.
    expect(chained.kind).toBe(expected);
    expect(chained.kind).toBe(separate.kind);
    if (chained.kind === "block") {
      // Same refusal, not merely the same verdict.
      expect(chained.text).toBe(separate.text);
    }
  });

  // Every guard after the first refusal is skipped, which is what makes a refusal
  // terminal: a denied call must not go on to have later side effects applied to it.
  test("a refusal stops the chain, so no later guard records anything", () => {
    const payload = {
      tool_name: "Bash",
      agent_type: "developer",
      session_id: SESSION_ID,
      agent_id: "a1111111111111111",
      tool_input: { command: "npm run typecheck" },
    };
    run(hook("pre-tool-bash"), payload);
    // circuit-breaker sits after bash-guard and counts every call it sees.
    expect(existsSync(join(sessionDir, "breaker"))).toBe(false);
  });

  test("a guard that allows does not stop the ones after it", () => {
    const payload = {
      tool_name: "Bash",
      agent_type: "developer",
      session_id: SESSION_ID,
      agent_id: "a2222222222222222",
      tool_input: { command: "npm install lodash" },
    };
    expect(verdict(run(hook("pre-tool-bash"), payload)).kind).toBe("allow");
    // bash-guard allowed it, so circuit-breaker (4th in the chain) still counted it.
    const breaker = join(sessionDir, "breaker");
    expect(existsSync(breaker)).toBe(true);
    const counters = readdirSync(breaker).filter((f) =>
      f.startsWith("bash-count-"),
    );
    expect(counters.length).toBe(1);
    expect(readFileSync(join(breaker, counters[0]), "utf8").trim()).not.toBe(
      "",
    );
  });

  // Each guard keeps its own name, so hooks.log stays greppable per guard.
  test("each guard logs under its own prefix", () => {
    run(hook("pre-tool-bash"), {
      tool_name: "Bash",
      agent_type: "developer",
      session_id: SESSION_ID,
      agent_id: "a3333333333333333",
      tool_input: { command: "npm install lodash" },
    });
    const log = readFileSync(join(sessionDir, "hooks.log"), "utf8");
    expect(log).toContain("[circuit-breaker]");
  });

  // An unparseable payload is not a decision. It reaches every guard as {}, so the ones
  // that key on a command wave it through and the one that knows who it is from an env
  // var still refuses.
  describe("an unparseable payload", () => {
    test("is allowed through for a command-keyed guard", () => {
      const r = spawnSync("node", [hook("pre-tool-bash")], {
        input: "not json",
        env,
        encoding: "utf8",
      });
      expect(r.status).toBe(0);
      expect(verdict(r).kind).toBe("allow");
    });

    test("is still refused for the documentator, which knows itself from the env", () => {
      const r = spawnSync("node", [hook("pre-tool-bash")], {
        input: "not json",
        env: { ...env, DOCUMENTATOR_RUN: "1" },
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
      expect(r.stderr).toContain("empty or unparseable command");
    });
  });
});

describe("pre-tool-agent dispatcher", () => {
  const CASES = [
    [
      "the orchestrator dispatching general-purpose is refused",
      {
        agent_type: "orchestrator",
        agent_id: "a4444444444444444",
        tool_input: { subagent_type: "general-purpose", prompt: "explore" },
      },
      "block",
    ],
    [
      "a merger for a ticket with no APPROVED verdict is refused",
      {
        agent_type: "orchestrator",
        agent_id: "a5555555555555555",
        tool_input: {
          subagent_type: "merger",
          prompt: "TASK_ID: TASK-001\nSTAGE: a-only",
        },
      },
      "fail",
    ],
    [
      "a developer with no WORKTREE_PATH is refused",
      {
        agent_type: "orchestrator",
        agent_id: "a6666666666666666",
        tool_input: { subagent_type: "developer", prompt: "TASK_ID: TASK-002" },
      },
      "fail",
    ],
    [
      "a quality-reviewer dispatch is allowed",
      {
        agent_type: "orchestrator",
        agent_id: "a7777777777777777",
        tool_input: {
          subagent_type: "quality-reviewer",
          prompt: "TASK_ID: TASK-003",
        },
      },
      "allow",
    ],
  ];

  test.each(CASES)("%s, and identically either way", (_label, c, expected) => {
    const payload = {
      tool_name: "Agent",
      session_id: SESSION_ID,
      ...c,
    };
    const chained = verdict(run(hook("pre-tool-agent"), payload));
    const separate = runSeparateGuards(AGENT_GUARDS, {
      ...payload,
      session_id: SEPARATE_SESSION,
    });
    expect(chained.kind).toBe(expected);
    expect(chained.kind).toBe(separate.kind);
  });

  // record-merger-stage sits AFTER the two merger gates, so a merger that is refused
  // for want of a review leaves no promotion-authorization marker behind.
  test("a refused merger writes no stage marker", () => {
    run(hook("pre-tool-agent"), {
      tool_name: "Agent",
      session_id: SESSION_ID,
      agent_type: "orchestrator",
      agent_id: "a8888888888888888",
      tool_input: {
        subagent_type: "merger",
        prompt: "TASK_ID: TASK-001\nSTAGE: a-only",
      },
    });
    expect(existsSync(join(sessionDir, "merger-stage.json"))).toBe(false);
  });
});
