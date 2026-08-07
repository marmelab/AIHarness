// Tests for lib/e2e-result.mjs: WHICH e2e failure a run hit.
//
// The signature is what lets a fix-round budget be spent per distinct failure. A global
// budget is spent by whichever bugs surface first, so a suite with three defects ships red
// on the third without one attempt at it. Two properties carry that:
//
//   - the same bug across re-runs produces the SAME signature, or the budget silently
//     degrades back into a global one as timings and ports shift between runs.
//   - a different bug produces a DIFFERENT one, or the reset never fires.

import { describe, expect, test } from "vitest";
import { failureSignature } from "../lib/e2e-result.mjs";

// Playwright's failure block, as it reaches the hook through e2e-smoke.sh.
const failure = ({
  spec = "e2e/deal-import.spec.ts",
  line = "12:5",
  title = "import deals › shows the preview",
  error = "Error: expect(locator).toBeVisible() failed",
  ms = 4321,
} = {}) =>
  [
    "Running 12 tests using 4 workers",
    "",
    `  1) [chromium] › ${spec}:${line} › ${title} ─────────────────────────────`,
    "",
    `    ${error}`,
    "",
    `    Locator: getByRole('table')`,
    `    Timeout: ${ms}ms`,
    "",
    "  1 failed",
    `e2e-smoke: suite exit=1 (slot 2)`,
  ].join("\n");

describe("failureSignature: the same bug is the same signature", () => {
  test("two runs of one failure agree", () => {
    expect(failureSignature(failure())).toBe(failureSignature(failure()));
  });

  // Between two runs of the SAME bug these all move. If any of them reached the hash, the
  // per-signature budget would reset on every re-run and never bound anything.
  test("timings, ports, temp paths and slot numbers do not change it", () => {
    const base = failureSignature(failure());
    expect(failureSignature(failure({ ms: 9876 }))).toBe(base);
    expect(
      failureSignature(
        failure({
          error: "Error: page.goto: connect ECONNREFUSED 127.0.0.1:54341",
        }),
      ),
    ).toBe(
      failureSignature(
        failure({
          error: "Error: page.goto: connect ECONNREFUSED 127.0.0.1:54381",
        }),
      ),
    );
    expect(
      failureSignature(
        failure({ error: "Error: ENOENT /tmp/e2e-a1b2/app.log" }),
      ),
    ).toBe(
      failureSignature(
        failure({ error: "Error: ENOENT /tmp/e2e-z9y8/app.log" }),
      ),
    );
  });

  test("a different line in the same spec is still the same failure", () => {
    expect(failureSignature(failure({ line: "40:3" }))).toBe(
      failureSignature(failure({ line: "12:5" })),
    );
  });
});

describe("failureSignature: a different bug is a different signature", () => {
  test("another spec", () => {
    expect(
      failureSignature(failure({ spec: "e2e/deal-list.spec.ts" })),
    ).not.toBe(failureSignature(failure()));
  });

  test("another error in the same spec", () => {
    expect(
      failureSignature(
        failure({
          error:
            "Error: Cannot read properties of undefined (reading 'parse') [papaparse]",
        }),
      ),
    ).not.toBe(failureSignature(failure()));
  });

  // The exact shape of the audited sequence: two shallow locator bugs and then a distinct
  // interop bug. Three signatures means the third one gets its own budget.
  test("three failures in one suite produce three signatures", () => {
    const signatures = new Set(
      [
        failure({
          spec: "e2e/import.spec.ts",
          error: "Error: expect(locator).toBeVisible() failed",
        }),
        failure({
          spec: "e2e/import.spec.ts",
          error:
            "Error: strict mode violation: getByRole('row') resolved to 3 elements",
        }),
        failure({
          spec: "e2e/import.spec.ts",
          error: "TypeError: papaparse_1.default.parse is not a function",
        }),
      ].map(failureSignature),
    );
    expect(signatures.size).toBe(3);
  });
});

describe("failureSignature: nothing recognisable means no signature", () => {
  // "" tells the caller to fall back to its global cap, rather than every unparseable run
  // colliding on one signature and sharing a budget they have nothing to do with.
  test.each([
    ["", "empty output"],
    ["   \n  \n", "whitespace"],
    ["e2e-smoke: suite exit=1 (slot 2)", "an exit line with no failure block"],
    ["SKIP: all 5 e2e slots busy; try again later.", "a graceful skip"],
    ["Docker daemon is not running", "an infrastructure error"],
  ])("%j -> no signature (%s)", (output) => {
    expect(failureSignature(output)).toBe("");
  });

  test("null and undefined are handled, never a crash", () => {
    expect(failureSignature(undefined)).toBe("");
    expect(failureSignature(null)).toBe("");
  });

  // A spec named anywhere still yields a signature even without a numbered header, so an
  // unusual reporter format degrades to "some signature" rather than to none.
  test("a bare spec mention still produces one", () => {
    expect(failureSignature("failed: e2e/deal.spec.ts timed out")).not.toBe("");
  });
});
