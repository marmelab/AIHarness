// Tests for lib/verdict.mjs: parsing the quality-reviewer's contract line.
//
// This parser is the ONLY thing standing between a review and its consequences now that no
// agent writes its own verdict flag: record-review-verdict writes the flag from it, and
// e2e-on-feature-review decides whether to spend 10 minutes on a suite from it. Three
// properties matter, and each has a failure that is worse than a crash:
//
//   - a negative is recognised in BOTH vocabularies. The per-ticket review ends on
//     `REJECTED:`, the feature / SIMPLE / migration passes end on `BLOCKED:`. A parser
//     blind to one reads that review as unparseable, leaves an earlier APPROVED flag in
//     place, and the suite runs on work the reviewer just refused.
//   - trailing prose never FLIPS a verdict, in either direction.
//   - anything unparseable stays unparseable. "" is not "approved by default".

import { describe, expect, test } from "vitest";
import { parseVerdict, verdictSource } from "../lib/verdict.mjs";

describe("parseVerdict: the clean markers", () => {
  test.each([
    ["APPROVED", "APPROVED"],
    ["APPROVED.", "APPROVED"],
    ["APPROVED!", "APPROVED"],
    ["  APPROVED  ", "APPROVED"],
    ["REJECTED: do X", "REJECTED"],
    ["BLOCKED: the filter is missing", "REJECTED"],
  ])("%j -> %s", (input, expected) => {
    expect(parseVerdict(input)).toBe(expected);
  });

  test("both negative vocabularies map to one result", () => {
    expect(parseVerdict("REJECTED:\n- a.ts:1 - missing check")).toBe(
      "REJECTED",
    );
    expect(parseVerdict("BLOCKED:\n- a.ts:1 - missing check")).toBe("REJECTED");
  });
});

describe("parseVerdict: the verdict is the LAST clean marker", () => {
  test("a final APPROVED after preamble prose", () => {
    expect(parseVerdict("Part C: integration present\nAPPROVED")).toBe(
      "APPROVED",
    );
  });

  // The contract puts a findings list AFTER the negative marker, so the marker is not the
  // last line. Scanning bottom-up has to walk past the bullets.
  test.each(["REJECTED", "BLOCKED"])(
    "%s: followed by its bulleted findings",
    (word) => {
      expect(
        parseVerdict(
          `Findings:\n${word}:\n- src/foo.ts: missing null check\n- src/bar.ts: wrong import`,
        ),
      ).toBe("REJECTED");
    },
  );

  test("a hotspots section above the line does not become the verdict", () => {
    const src = [
      "Hotspots for human review:",
      "- src/auth.ts:42 - token refresh has no retry",
      "APPROVED",
    ].join("\n");
    expect(parseVerdict(src)).toBe("APPROVED");
  });
});

describe("parseVerdict: trailing prose never flips a verdict", () => {
  test("prose starting with REJECTED after a real APPROVED is ignored", () => {
    expect(
      parseVerdict(
        "APPROVED\nREJECTED concerns from the first pass are resolved.",
      ),
    ).toBe("APPROVED");
  });

  test("prose starting with BLOCKED after a real APPROVED is ignored", () => {
    expect(
      parseVerdict("APPROVED\nBLOCKED flows from round 1 all pass now."),
    ).toBe("APPROVED");
  });

  test("APPROVED as a word inside prose is not a verdict", () => {
    expect(parseVerdict("The APPROVED parts are in src/a.ts")).toBe("");
    expect(parseVerdict("Everything is APPROVED so far, but")).toBe("");
  });

  test("a real negative after an earlier APPROVED wins, being later", () => {
    expect(
      parseVerdict("APPROVED\nREJECTED: on reflection, a.ts:1 is wrong"),
    ).toBe("REJECTED");
  });
});

describe("parseVerdict: no verdict means no verdict", () => {
  test.each([
    "",
    "   ",
    "I am still thinking about it",
    "Verdict: APPROVED",
    "REJECTED",
    "BLOCKED",
    "approved",
  ])("%j is unparseable", (input) => {
    expect(parseVerdict(input)).toBe("");
  });

  test("null and undefined are unparseable, never a crash", () => {
    expect(parseVerdict(undefined)).toBe("");
    expect(parseVerdict(null)).toBe("");
  });
});

describe("verdictSource: which text the verdict was read from", () => {
  // A whole run logged an unrecognised verdict on every stop while its reviewers ended on a
  // clean APPROVED, and the diagnostic could not say whether the hook had read the payload's
  // message or fallen back to a transcript. Naming the source, and showing how the text
  // ends, is what tells "the reviewer said nothing yet" from "we read the wrong agent".
  test("names the payload and shows the tail when the runtime supplies the message", () => {
    const r = verdictSource({
      last_assistant_message: "Findings:\n- one\n\nAPPROVED",
    });
    expect(r.source).toBe("payload");
    expect(r.tail.endsWith("APPROVED")).toBe(true);
  });

  test("reports none, not an empty payload read, when there is nothing to parse", () => {
    const r = verdictSource({});
    expect(r.source).toBe("none");
    expect(r.tail).toBe("");
  });

  test("collapses newlines so the tail stays one log line", () => {
    const r = verdictSource({ last_assistant_message: "a\n\nb\nAPPROVED" });
    expect(r.tail).not.toContain("\n");
  });
});
