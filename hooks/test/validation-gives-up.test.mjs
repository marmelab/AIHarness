// Tests for the validation chain's failure budget, in lib/validation.mjs, and the merge
// refusal it triggers in block-merger-without-review.mjs.
//
// Refusing a red stop with no budget wedges the ticket: a developer thrashing on one failing
// step is refused forever, with no signal to the orchestrator and no way to give up
// (validate-on-stop does not read the FAILED contract line).
//
// So the chain gives up after a bounded number of consecutive failures per step, releases the
// stop, and records why. "We never merge red" then survives in the merger gate rather than in
// an unbounded refusal.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const STOP_HOOK = join(HERE, "..", "validate-on-stop.mjs");
const MERGER_HOOK = join(HERE, "..", "block-merger-without-review.mjs");
const SESSION_ID = "gv1a2b3c-1111-2222-3333-444455556666";
const SHORT = "gv1a2b3c";
const LIMIT = 5;

let TMP, APP_DIR, TMP_ROOT, SESSION_DIR, WT, env, layout;

const g = (cwd, ...args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

// One always-failing unit step, so the budget is the only thing under test.
const CONFIG = {
  validation: {
    steps: [{ id: "unit-app", kind: "unit", command: "false" }],
    extraForbidden: [],
  },
  roles: {
    developer: { model: "sonnet" },
    "quality-reviewer": { model: "opus" },
  },
};

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "validation-gives-up-"));
  APP_DIR = join(TMP, "app");
  TMP_ROOT = join(TMP, "scratch");
  SESSION_DIR = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(APP_DIR, { recursive: true });
  writeFileSync(join(APP_DIR, "harness.config.json"), JSON.stringify(CONFIG));

  g(APP_DIR, "init", "-q", "-b", "main");
  g(APP_DIR, "config", "user.email", "t@t.t");
  g(APP_DIR, "config", "user.name", "t");
  writeFileSync(join(APP_DIR, "seed.ts"), "export const a = 1;\n");
  g(APP_DIR, "add", "-A");
  g(APP_DIR, "commit", "-q", "-m", "seed");
  g(APP_DIR, "branch", `session/${SHORT}`);

  WT = join(SESSION_DIR, "TASK-001");
  g(
    APP_DIR,
    "worktree",
    "add",
    "-q",
    "-b",
    `${SHORT}/TASK-001`,
    WT,
    `session/${SHORT}`,
  );
  // A committed change, so the uncommitted-work check passes and the unit step is reached.
  writeFileSync(join(WT, "seed.ts"), "export const a = 2;\n");
  g(WT, "add", "-A");
  g(WT, "commit", "-q", "-m", "feat(TASK-001): change");

  layout = runtimeLayout(join(TMP, "transcripts"), SESSION_ID);
  spawnAgent(
    layout,
    "a00000000000000051",
    { agentType: "developer", description: "Implement TASK-001: change" },
    "ROLE: developer\nTASK_ID: TASK-001\n",
  );

  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.VALIDATE_DRY_RUN;
  delete env.VALIDATE_WORKTREE;
  delete env.VALIDATE_NO_CACHE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
});

afterEach(() => {
  g(APP_DIR, "worktree", "remove", "--force", WT);
  rmSync(TMP, { recursive: true, force: true });
});

// The TASK-001 developer's stop, in the shape the runtime sends: empty agent_type, the
// MAIN session transcript, and the identity carried by agent_id. The hook attributes the
// worktree from the spawn meta's description, which is what scopes the chain to TASK-001.
const stop = () =>
  spawnSync("node", [STOP_HOOK], {
    input: JSON.stringify(stopPayload(layout, "a00000000000000051")),
    env,
    encoding: "utf8",
  });

const dispatchMerger = (taskId) =>
  spawnSync("node", [MERGER_HOOK], {
    input: JSON.stringify({
      tool_name: "Agent",
      session_id: SESSION_ID,
      tool_input: {
        subagent_type: "merger",
        prompt: `ROLE: merger\nTASK_ID: ${taskId}\nSTAGE: a-only\n`,
      },
    }),
    env,
    encoding: "utf8",
  });

const gaveUpFlag = () => join(SESSION_DIR, "validation-gave-up", "TASK-001");
const approve = () => {
  const dir = join(SESSION_DIR, "reviews");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "TASK-001-quality-reviewer"), "");
};

describe("the validation chain's failure budget", () => {
  test("refuses the stop up to the limit, then releases it", () => {
    for (let i = 1; i < LIMIT; i++) {
      const r = stop();
      expect(r.status).toBe(2);
      expect(r.stderr).toContain(`attempt ${i}/${LIMIT}`);
    }
    // The last one releases rather than wedging.
    expect(stop().status).toBe(0);
  });

  test("warns on the penultimate attempt that the next one gives up", () => {
    for (let i = 1; i < LIMIT - 1; i++) stop();
    expect(stop().stderr).toContain("LAST attempt");
  });

  test("records why it gave up", () => {
    for (let i = 0; i < LIMIT; i++) stop();
    expect(existsSync(gaveUpFlag())).toBe(true);
    const r = JSON.parse(readFileSync(gaveUpFlag(), "utf8"));
    expect(r.kind).toBe("validation-gave-up");
    expect(r.taskId).toBe("TASK-001");
    expect(r.step).toBe("unit-app");
    expect(r.attempts).toBe(LIMIT);
  });
});

describe("giving up is recoverable", () => {
  // Without this the documented fix cannot work: the marker outlives the repair and the merge
  // stays refused, leaving no exit but deleting the file the block message forbids deleting.
  test("a green run clears the marker and the merge is allowed again", () => {
    for (let i = 0; i < LIMIT; i++) stop();
    expect(existsSync(gaveUpFlag())).toBe(true);
    approve();
    expect(dispatchMerger("TASK-001").status).toBe(2);

    // The step now passes, which is what a developer dispatched to fix it would achieve.
    writeFileSync(
      join(APP_DIR, "harness.config.json"),
      JSON.stringify({
        ...CONFIG,
        validation: {
          steps: [{ id: "unit-app", kind: "unit", command: "true" }],
          extraForbidden: [],
        },
      }),
    );
    expect(stop().status).toBe(0);
    expect(existsSync(gaveUpFlag())).toBe(false);
    expect(dispatchMerger("TASK-001").status).toBe(0);
  });
});

describe("giving up does not mean merging red", () => {
  test("the merger is refused for a ticket whose validation gave up", () => {
    for (let i = 0; i < LIMIT; i++) stop();
    approve(); // even WITH an approved review, the merge is refused
    const r = dispatchMerger("TASK-001");
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("never reached green");
    expect(r.stderr).toContain("unit-app");
  });

  test("a different ticket is unaffected", () => {
    for (let i = 0; i < LIMIT; i++) stop();
    const dir = join(SESSION_DIR, "reviews");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "TASK-002-quality-reviewer"), "");
    expect(dispatchMerger("TASK-002").status).toBe(0);
  });

  test("without the marker, an approved ticket merges as before", () => {
    approve();
    expect(existsSync(gaveUpFlag())).toBe(false);
    expect(dispatchMerger("TASK-001").status).toBe(0);
  });
});
