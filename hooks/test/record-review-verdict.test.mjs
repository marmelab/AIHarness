// Tests for record-review-verdict.mjs (vitest, "claude" Node project). A
// reviewer's final contract line (APPROVED / REJECTED) becomes a per-ticket flag
// under <sessionDir>/reviews/<TASK>-<role>, read later by
// block-merger-without-review.mjs. Verdict source here is last_assistant_message.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { describe, test, expect, beforeAll, afterAll } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "record-review-verdict.mjs");
const SESSION_ID = "deadbeef-1111-2222-3333-444455556666";

let TMP;
let APP_DIR;
let env;
let reviewsDir;

const run = (payload) =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify({ session_id: SESSION_ID, ...payload }),
    env,
    encoding: "utf8",
  });
const flag = (name) => join(reviewsDir, name);

// A stop as the RUNTIME sends it: empty agent_type, no last_assistant_message, the MAIN
// session transcript in transcript_path, and the identity carried only by agent_id. The
// verdict has to come out of the agent's own transcript.
let layoutSeq = 0;
const runtimeStop = (agentId, meta, dispatchPrompt, finalMessage) => {
  const layout = runtimeLayout(join(TMP, `rt${layoutSeq++}`), SESSION_ID);
  spawnAgent(layout, agentId, meta, dispatchPrompt, [finalMessage]);
  return run(stopPayload(layout, agentId));
};

beforeAll(() => {
  TMP = mkdtempSync(join(tmpdir(), "record-verdict-test-"));
  APP_DIR = join(TMP, "app");
  const HARNESS_TMP_ROOT = join(TMP, "scratch");
  reviewsDir = join(
    HARNESS_TMP_ROOT,
    sanitizePath(APP_DIR),
    SESSION_ID,
    "reviews",
  );
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT };
  delete env.CLAUDE_AGENT_NAME;
  // These tests assert the flag lands under ctx.sessionDir (HARNESS_TMP_ROOT/...).
  // reviewsDir() prefers CHAT_SESSION_DIR when set (managed-launcher path), so a
  // CHAT_SESSION_DIR inherited from the ambient env (e.g. CRM Builder's container)
  // would redirect the flag and break the assertion — neutralise it here. The
  // CHAT_SESSION_DIR-present path is covered by reviews.test.mjs.
  delete env.CHAT_SESSION_DIR;
});

afterAll(() => rmSync(TMP, { recursive: true, force: true }));

describe("record-review-verdict", () => {
  test("APPROVED writes the per-ticket flag", () => {
    run({
      agent_type: "quality-reviewer-TASK-007",
      last_assistant_message: "APPROVED",
    });
    expect(existsSync(flag("TASK-007-quality-reviewer"))).toBe(true);
  });

  test("REJECTED clears a prior flag", () => {
    run({
      agent_type: "quality-reviewer-TASK-007",
      last_assistant_message: "REJECTED: do X",
    });
    expect(existsSync(flag("TASK-007-quality-reviewer"))).toBe(false);
  });

  test("records the flag from a final APPROVED after preamble prose", () => {
    run({
      agent_type: "quality-reviewer-TASK-011",
      last_assistant_message: "Part C — integration: present\nAPPROVED",
    });
    expect(existsSync(flag("TASK-011-quality-reviewer"))).toBe(true);
  });

  test("multi-line REJECTED (bulleted feedback) clears a prior flag", () => {
    // Arrange: a prior APPROVED flag exists for this ticket/role.
    run({
      agent_type: "quality-reviewer-TASK-009",
      last_assistant_message: "APPROVED",
    });
    expect(existsSync(flag("TASK-009-quality-reviewer"))).toBe(true);
    // Act: a re-review rejects using the contract's bulleted-list feedback, so
    // the REJECTED keyword is NOT on the final line.
    run({
      agent_type: "quality-reviewer-TASK-009",
      last_assistant_message:
        "Findings:\nREJECTED:\n- src/foo.ts: missing null check\n- src/bar.ts: wrong import",
    });
    // Assert: the stale APPROVED flag is cleared.
    expect(existsSync(flag("TASK-009-quality-reviewer"))).toBe(false);
  });

  test("trailing prose starting with REJECTED does not flip a real APPROVED", () => {
    // A chatty reviewer that approves but adds a clarifying sentence which happens
    // to start with the keyword must NOT be recorded as REJECTED. The contract
    // REJECTED form requires a colon (`REJECTED:`), so this trailing prose is
    // ignored and the standalone APPROVED above wins.
    run({
      agent_type: "quality-reviewer-TASK-010",
      last_assistant_message:
        "APPROVED\nREJECTED concerns from the first pass are now resolved.",
    });
    expect(existsSync(flag("TASK-010-quality-reviewer"))).toBe(true);
  });

  test("standalone APPROVED with a trailing note still approves", () => {
    run({
      agent_type: "quality-reviewer-TASK-012",
      last_assistant_message: "APPROVED\nNice work — all e2e specs present.",
    });
    expect(existsSync(flag("TASK-012-quality-reviewer"))).toBe(true);
  });

  test("unknown verdict leaves state untouched (no flag written)", () => {
    run({
      agent_type: "quality-reviewer-TASK-008",
      last_assistant_message: "I am still thinking about it",
    });
    expect(existsSync(flag("TASK-008-quality-reviewer"))).toBe(false);
  });
});

// The end-of-feature review has NO ticket, so every TASK-id recovery came back empty and
// the hook logged task=UNKNOWN for all of them: the flag e2e-on-feature-review gates the
// suite on was never written by the fallback. These run the payload shape the runtime
// actually sends, which is the only shape that could have caught it.
describe("record-review-verdict on a real runtime stop", () => {
  test("(b) a MODE: feature-review reviewer with no TASK id is keyed on FEATURE", () => {
    const r = runtimeStop(
      "a00000000000000021",
      {
        agentType: "aiharness:quality-reviewer",
        description: "Feature review",
      },
      "ROLE: quality-reviewer\nMODE: feature-review\nTICKETS_DIR: /tmp/s\n",
      "All parts integrate.\nAPPROVED",
    );
    expect(r.status).toBe(0);
    expect(existsSync(flag("FEATURE-quality-reviewer"))).toBe(true);
  });

  test("a REJECTED feature review clears the FEATURE flag", () => {
    runtimeStop(
      "a00000000000000022",
      { agentType: "quality-reviewer", description: "Feature review" },
      "ROLE: quality-reviewer\nMODE: feature-review\n",
      "APPROVED",
    );
    expect(existsSync(flag("FEATURE-quality-reviewer"))).toBe(true);
    runtimeStop(
      "a00000000000000023",
      { agentType: "quality-reviewer", description: "Feature review" },
      "ROLE: quality-reviewer\nMODE: feature-review\n",
      "REJECTED:\n- the importance filter is missing",
    );
    expect(existsSync(flag("FEATURE-quality-reviewer"))).toBe(false);
  });

  test("a per-ticket review is still keyed on its ticket, not on FEATURE", () => {
    runtimeStop(
      "a00000000000000024",
      { agentType: "quality-reviewer", description: "Review TASK-021" },
      "ROLE: quality-reviewer\nTASK_ID: TASK-021\n",
      "APPROVED",
    );
    expect(existsSync(flag("TASK-021-quality-reviewer"))).toBe(true);
  });

  // FEATURE is a review verdict. Only a reviewer may write one, whatever a stopping
  // developer or merger happens to have said last.
  test("a developer stop cannot write a review verdict", () => {
    runtimeStop(
      "a00000000000000025",
      { agentType: "developer", description: "Implement TASK-022" },
      "ROLE: developer\nTASK_ID: TASK-022\nMODE: feature-review\n",
      "APPROVED",
    );
    expect(existsSync(flag("FEATURE-quality-reviewer"))).toBe(false);
    expect(existsSync(flag("TASK-022-quality-reviewer"))).toBe(false);
  });

  // The regression that made this whole family invisible: the payload's transcript_path
  // is the MAIN session transcript. Scanning it recovers whatever was dispatched FIRST
  // and reads the ORCHESTRATOR's last message as the reviewer's verdict.
  test("the main session transcript is never read as the reviewer's own", () => {
    const layout = runtimeLayout(join(TMP, "leak"), SESSION_ID);
    // The MAIN transcript, which is what the payload names: it holds an EARLIER review
    // dispatch for TASK-030 and an APPROVED. Scanning it keys the verdict on the first
    // ticket of the session and reads someone else's message as this reviewer's.
    writeFileSync(
      layout.mainTranscript,
      [
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: "ROLE: quality-reviewer\nTASK_ID: TASK-030\n",
          },
        }),
        JSON.stringify({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "APPROVED" }],
          },
        }),
      ].join("\n") + "\n",
    );
    // What is actually stopping: the TASK-031 reviewer, and it REJECTED.
    spawnAgent(
      layout,
      "a00000000000000026",
      { agentType: "quality-reviewer", description: "Review TASK-031" },
      "ROLE: quality-reviewer\nTASK_ID: TASK-031\n",
      ["REJECTED:\n- the importance filter is missing"],
    );
    mkdirSync(reviewsDir, { recursive: true });
    writeFileSync(flag("TASK-031-quality-reviewer"), "");

    const r = run(stopPayload(layout, "a00000000000000026"));
    expect(r.status).toBe(0);
    // The reviewer's own REJECTED was read, so its own flag is cleared...
    expect(existsSync(flag("TASK-031-quality-reviewer"))).toBe(false);
    // ...and the main transcript's ticket and APPROVED were not.
    expect(existsSync(flag("TASK-030-quality-reviewer"))).toBe(false);
  });
});
