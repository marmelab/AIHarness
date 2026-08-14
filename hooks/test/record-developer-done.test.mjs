// Tests for record-developer-done.mjs, the SubagentStop hook that appends a developer's
// own contract line to harness-progress.log, so the orchestrator no longer spends a whole
// turn echoing it. Purely informational: it writes no flag and gates nothing, so every
// unresolvable case must exit 0 having written nothing.
//
// The log is only ever APPENDED to, never created, because its existence is the
// technical-run gate (see lib/progress-log.mjs): a non-technical run has no log and must
// not acquire one.

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
import { spawnSync } from "node:child_process";
import { describe, test, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";
import { parseDeveloperContract } from "../lib/dev-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "record-developer-done.mjs");
const SESSION_ID = "beefcafe-1111-2222-3333-444455556666";

let TMP;
let APP_DIR;
let env;
let sessionDir;
let logFile;
let layoutSeq = 0;

const run = (payload) =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify({ session_id: SESSION_ID, ...payload }),
    env,
    encoding: "utf8",
  });

// A stop as the runtime sends it: identity carried by agent_id + the spawn meta, the
// contract line as the agent's last assistant turn.
const stopOf = (agentId, meta, dispatchPrompt, finalMessage) => {
  const layout = runtimeLayout(join(TMP, `rt${layoutSeq++}`), SESSION_ID);
  spawnAgent(layout, agentId, meta, dispatchPrompt, [finalMessage]);
  return run(stopPayload(layout, agentId));
};

const logLines = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8").split("\n").filter(Boolean)
    : [];

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "record-dev-done-test-"));
  APP_DIR = join(TMP, "app");
  const HARNESS_TMP_ROOT = join(TMP, "scratch");
  sessionDir = join(HARNESS_TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  logFile = join(sessionDir, "harness-progress.log");
  mkdirSync(sessionDir, { recursive: true });
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT };
  delete env.CLAUDE_AGENT_NAME;
  // ctx.sessionDir must resolve to the HARNESS_TMP_ROOT fixture, not to an ambient
  // managed-launcher dir inherited from the environment.
  delete env.CHAT_SESSION_DIR;
});

beforeEach(() => {
  writeFileSync(logFile, "");
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("parseDeveloperContract", () => {
  test("reads a DONE line with its branch, commit and files", () => {
    expect(
      parseDeveloperContract(
        "Implemented the field.\nDONE: branch=ab12/TASK-003 commit=deadbee files=[a.ts,b.ts]",
      ),
    ).toEqual({
      result: "DONE",
      detail: "branch=ab12/TASK-003 commit=deadbee files=[a.ts,b.ts]",
    });
  });

  test("reads a FAILED line with its reason", () => {
    expect(parseDeveloperContract("FAILED: out of scope, needs COMPLEX flow")).toEqual({
      result: "FAILED",
      detail: "out of scope, needs COMPLEX flow",
    });
  });

  test("takes the LAST contract line when an earlier attempt is quoted above", () => {
    expect(
      parseDeveloperContract(
        "First attempt said:\nFAILED: typecheck\nFixed it.\nDONE: branch=b commit=c files=[x.ts]",
      ).result,
    ).toBe("DONE");
  });

  test("ignores prose that merely mentions the words", () => {
    // No contract colon -> not a contract line. The orchestrator still learns the real
    // result from the dispatch's return value, so guessing here would only be able to
    // put a wrong line in the user's live feed.
    expect(parseDeveloperContract("The work is DONE and nothing FAILED.")).toBeNull();
    expect(parseDeveloperContract("")).toBeNull();
  });
});

describe("record-developer-done", () => {
  test("appends a developer's DONE, keyed by its ticket", () => {
    const res = stopOf(
      "a1",
      { agentType: "developer", description: "Implement TASK-003" },
      "ROLE: developer\nTASK_ID: TASK-003",
      "DONE: branch=ab12/TASK-003 commit=deadbee files=[ContactInputs.tsx]",
    );
    expect(res.status).toBe(0);
    expect(logLines()).toHaveLength(1);
    expect(logLines()[0]).toContain("[dev:TASK-003] DONE");
    expect(logLines()[0]).toContain("commit=deadbee");
  });

  test("appends a FAILED the same way", () => {
    stopOf(
      "a2",
      { agentType: "developer", description: "Implement TASK-004" },
      "ROLE: developer\nTASK_ID: TASK-004",
      "FAILED: out of scope, needs COMPLEX flow",
    );
    expect(logLines()[0]).toContain("[dev:TASK-004] FAILED out of scope");
  });

  test("keys a ticketless SIMPLE-flow developer as `simple`", () => {
    // The SIMPLE flow and every fix round dispatch a developer with an inline
    // CHANGE_REQUEST and no TASK_ID, so an absent ticket is normal, not a failure.
    stopOf(
      "a3",
      { agentType: "developer", description: "Fix feature-review findings" },
      "ROLE: developer\nCHANGE_REQUEST: derive importance_rank in the demo provider",
      "DONE: branch=ab12/simple commit=cafe123 files=[dataProvider.ts]",
    );
    expect(logLines()[0]).toContain("[dev:simple] DONE");
  });

  test("truncates an over-long files list so the feed stays readable", () => {
    const files = Array.from({ length: 60 }, (_, i) => `file${i}.ts`).join(",");
    stopOf(
      "a4",
      { agentType: "developer", description: "Implement TASK-005" },
      "ROLE: developer\nTASK_ID: TASK-005",
      `DONE: branch=b commit=c files=[${files}]`,
    );
    const line = logLines()[0];
    expect(line.length).toBeLessThan(300);
    expect(line).toContain("...");
  });

  test("stays silent for a non-developer stop", () => {
    // Every SubagentStop hook runs on every stop, so a reviewer's and the orchestrator's
    // own stop both reach this hook. The orchestrator's transcript holds the developer
    // dispatch prompts IT wrote plus every DONE line it parsed, so acting on anything but
    // a developer identity would let its summary forge a milestone.
    const res = stopOf(
      "a5",
      { agentType: "quality-reviewer", description: "Review TASK-003" },
      "ROLE: quality-reviewer\nTASK_ID: TASK-003",
      "APPROVED",
    );
    expect(res.status).toBe(0);
    expect(logLines()).toHaveLength(0);
  });

  test("stays silent when the orchestrator stops, even quoting a DONE line", () => {
    const res = stopOf(
      "a6",
      { agentType: "orchestrator", description: "Run the harness" },
      "GATE: plan\nPERSONA: technical",
      "TASK-003 done.\nDONE: branch=ab12/TASK-003 commit=deadbee files=[x.ts]",
    );
    expect(res.status).toBe(0);
    expect(logLines()).toHaveLength(0);
  });

  test("writes nothing when there is no parseable contract line", () => {
    const res = stopOf(
      "a7",
      { agentType: "developer", description: "Implement TASK-006" },
      "ROLE: developer\nTASK_ID: TASK-006",
      "Still working on the select input.",
    );
    expect(res.status).toBe(0);
    expect(logLines()).toHaveLength(0);
  });

  test("never creates the log: a non-technical run must not acquire a board", () => {
    rmSync(logFile, { force: true });
    const res = stopOf(
      "a8",
      { agentType: "developer", description: "Implement TASK-007" },
      "ROLE: developer\nTASK_ID: TASK-007",
      "DONE: branch=b commit=c files=[x.ts]",
    );
    expect(res.status).toBe(0);
    expect(existsSync(logFile)).toBe(false);
  });

  test("ignores the runtime's phantom stop", () => {
    // The runtime fires a stop of its own every ~32 s while an agent runs. It names no
    // agent, and its last assistant text is a mid-turn snapshot with no contract line.
    const layout = runtimeLayout(join(TMP, `rt${layoutSeq++}`), SESSION_ID);
    const res = run(stopPayload(layout));
    expect(res.status).toBe(0);
    expect(logLines()).toHaveLength(0);
  });
});
