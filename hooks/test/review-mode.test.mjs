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
import { afterAll, describe, expect, test } from "vitest";
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
