// Tests for lib/review-mode.mjs: which KIND of review a stopping reviewer was running.
//
// Two hooks read this and must agree (e2e-on-feature-review decides whether to pay for
// a 10-minute suite, record-review-verdict decides whether a verdict with no TASK id is
// the feature review's), which is why it is shared and why it is tested on its own.
//
// The regression it guards: reading the `MODE:` line from the payload's transcript_path.
// That file is the MAIN session transcript and it contains EVERY dispatch prompt of the
// session, so one feature-review dispatch there makes this answer "feature-review" for
// every stop that follows.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, test } from "vitest";
import { isFeatureReview, reviewMode } from "../lib/review-mode.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const TMP = mkdtempSync(join(tmpdir(), "review-mode-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

let seq = 0;
const session = () =>
  runtimeLayout(TMP, `rm${seq++}0000-1111-2222-3333-444455556666`);

describe("reviewMode", () => {
  test("a feature-review dispatch is recognised from the agent's own transcript", () => {
    const layout = session();
    spawnAgent(
      layout,
      "a00000000000000011",
      { agentType: "quality-reviewer", description: "End-of-feature review" },
      "ROLE: quality-reviewer\nMODE: feature-review\nTICKETS_DIR: /tmp/s\n",
    );
    const payload = stopPayload(layout, "a00000000000000011");
    expect(reviewMode(payload)).toBe("feature-review");
    expect(isFeatureReview(payload)).toBe(true);
  });

  test("a per-ticket review is neither mode", () => {
    const layout = session();
    spawnAgent(
      layout,
      "a00000000000000012",
      { agentType: "quality-reviewer", description: "Review TASK-003" },
      "ROLE: quality-reviewer\nTASK_ID: TASK-003\n",
    );
    expect(reviewMode(stopPayload(layout, "a00000000000000012"))).toBe("");
  });

  // The smoke dispatch has no description template, so an improvised description
  // mentioning the review must not trigger a second, duplicate suite run.
  test("feature-smoke ends the lookup, whatever its description says", () => {
    const layout = session();
    spawnAgent(
      layout,
      "a00000000000000013",
      {
        agentType: "quality-reviewer",
        description: "Feature-review smoke of the same feature",
      },
      "ROLE: quality-reviewer\nMODE: feature-smoke\n",
    );
    const payload = stopPayload(layout, "a00000000000000013");
    expect(reviewMode(payload)).toBe("feature-smoke");
    expect(isFeatureReview(payload)).toBe(false);
  });

  test("falls back to the dispatch description when no MODE line was flushed", () => {
    const layout = session();
    spawnAgent(layout, "a00000000000000014", {
      agentType: "quality-reviewer",
      description: "Feature-review: add deal importance",
    });
    expect(reviewMode(stopPayload(layout, "a00000000000000014"))).toBe(
      "feature-review",
    );
  });

  test("a MODE line in the MAIN transcript never leaks onto another agent's stop", () => {
    const layout = session();
    // The orchestrator dispatched a feature review earlier in the session, so the main
    // transcript carries the line. THIS stop is a developer's.
    writeFileSync(
      layout.mainTranscript,
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "ROLE: quality-reviewer\nMODE: feature-review\n",
        },
      }) + "\n",
    );
    spawnAgent(
      layout,
      "a00000000000000015",
      { agentType: "developer", description: "Implement TASK-002" },
      "ROLE: developer\nTASK_ID: TASK-002\n",
    );
    expect(reviewMode(stopPayload(layout, "a00000000000000015"))).toBe("");
  });

  test("an unresolvable identity is not a feature review", () => {
    // Fail closed on the expensive side: no identity means no 10-minute suite, rather
    // than a suite launched off the main transcript's contents.
    expect(reviewMode({})).toBe("");
    expect(isFeatureReview({})).toBe(false);
  });
});

// The livelock, reproduced. Every one of these passed BEFORE the fix, which is why the
// suite ran 14 times in one session while the tests stayed green: nothing here asked
// what happens when the agent that stops is the one that WROTE the dispatch prompt.
describe("reviewMode: the dispatcher never answers for its dispatchee", () => {
  const RUNTIME_NAME = process.env.CLAUDE_AGENT_NAME;
  afterEach(() => {
    if (RUNTIME_NAME === undefined) delete process.env.CLAUDE_AGENT_NAME;
    else process.env.CLAUDE_AGENT_NAME = RUNTIME_NAME;
  });

  // The orchestrator's transcript contains `MODE: feature-review` because IT wrote that
  // prompt when it dispatched the reviewer. Reading the file whole made every one of its
  // stops answer "feature-review", each one relaunching the suite and flipping
  // e2e-result.json back to `running` -- the state the orchestrator was waiting on.
  test("an orchestrator stop is not a feature review, though its transcript holds the MODE line", () => {
    const layout = session();
    spawnAgent(
      layout,
      "a00000000000000021",
      { agentType: "aiharness:orchestrator", description: "Deal importance" },
      "You are the orchestrator. Execute the plan.\n",
      [
        "Dispatching the end-of-feature review with:\nROLE: quality-reviewer\nMODE: feature-review\n",
      ],
    );
    expect(reviewMode(stopPayload(layout, "a00000000000000021"))).toBe("");
    expect(isFeatureReview(stopPayload(layout, "a00000000000000021"))).toBe(
      false,
    );
  });

  // Same leak, one level down: a reviewer that quotes the line in its report rather than
  // having been dispatched with it.
  test("a per-ticket reviewer quoting the MODE line in its report is not a feature review", () => {
    const layout = session();
    spawnAgent(
      layout,
      "a00000000000000022",
      { agentType: "quality-reviewer", description: "Review TASK-003" },
      "ROLE: quality-reviewer\nTASK_ID: TASK-003\n",
      [
        "The end-of-feature pass (MODE: feature-review) will re-check this.\nAPPROVED",
      ],
    );
    expect(reviewMode(stopPayload(layout, "a00000000000000022"))).toBe("");
  });

  // The role check alone would not hold: with no agent id in the payload, identity falls
  // to the newest-dispatch guess, which names the reviewer that stopped minutes earlier.
  // CLAUDE_AGENT_NAME is what tells the truth, so the guess must lose to it.
  test("the runtime name beats a guess that names the wrong agent", () => {
    const layout = session();
    spawnAgent(
      layout,
      "a00000000000000023",
      {
        agentType: "quality-reviewer",
        description: "Feature-review: importance",
      },
      "ROLE: quality-reviewer\nMODE: feature-review\n",
    );
    // No agent_id: the resolver can only guess, and the only candidate is the reviewer.
    const payload = stopPayload(layout);
    process.env.CLAUDE_AGENT_NAME = "aiharness:orchestrator";
    expect(reviewMode(payload)).toBe("");
    expect(isFeatureReview(payload)).toBe(false);
  });

  test("the reviewer's own stop still is a feature review under the same runtime name", () => {
    const layout = session();
    spawnAgent(
      layout,
      "a00000000000000024",
      {
        agentType: "quality-reviewer",
        description: "Feature-review: importance",
      },
      "ROLE: quality-reviewer\nMODE: feature-review\n",
    );
    process.env.CLAUDE_AGENT_NAME = "quality-reviewer";
    expect(isFeatureReview(stopPayload(layout, "a00000000000000024"))).toBe(
      true,
    );
  });
});
