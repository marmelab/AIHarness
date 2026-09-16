// Tests for lib/acceptance.mjs: the one reader of a ticket's acceptance criteria and open
// questions. Two shapes exist on disk, the legacy array of strings and the {text, source}
// table, and the plan grill asks about exactly the rows this module marks `derived`, so a
// normalisation that guesses wrong either interrogates the human about a settled point or
// lets an invented criterion through unasked.

import { describe, expect, test } from "vitest";
import {
  GRADES,
  SOURCES,
  derivedCount,
  readCriteria,
  readOpenQuestions,
} from "../lib/acceptance.mjs";

describe("readCriteria", () => {
  test("a table of objects keeps each text and source", () => {
    const r = readCriteria({
      acceptance_criteria: [
        { text: "a", source: "request" },
        { text: "b", source: "derived" },
      ],
    });
    expect(r.shape).toBe("table");
    expect(r.criteria).toEqual([
      { text: "a", source: "request" },
      { text: "b", source: "derived" },
    ]);
  });

  test("a legacy string array reads as request, so it asks nothing", () => {
    const r = readCriteria({ acceptance_criteria: ["a", "b"] });
    expect(r.shape).toBe("legacy");
    expect(r.criteria).toEqual([
      { text: "a", source: "request" },
      { text: "b", source: "request" },
    ]);
  });

  test("an unrecognised source becomes derived, so the doubt is asked not skipped", () => {
    const r = readCriteria({
      acceptance_criteria: [{ text: "a", source: "guess" }],
    });
    expect(r.criteria[0].source).toBe("derived");
  });

  test("absent, null or non-array criteria are shape=missing", () => {
    expect(readCriteria({}).shape).toBe("missing");
    expect(readCriteria({ acceptance_criteria: null }).shape).toBe("missing");
    expect(readCriteria({ acceptance_criteria: "x" }).shape).toBe("missing");
    expect(readCriteria(null).shape).toBe("missing");
  });

  test("a mixed array is shape=table and the strings still read as request", () => {
    const r = readCriteria({
      acceptance_criteria: ["a", { text: "b", source: "derived" }],
    });
    expect(r.shape).toBe("table");
    expect(r.criteria[0]).toEqual({ text: "a", source: "request" });
    expect(r.criteria[1].source).toBe("derived");
  });

  test("a row with no usable text is dropped", () => {
    const r = readCriteria({
      acceptance_criteria: [{ source: "request" }, { text: "  " }],
    });
    expect(r.criteria).toEqual([]);
  });

  test("the vocabularies are the documented ones", () => {
    expect(SOURCES).toEqual(["request", "derived"]);
    expect(GRADES).toEqual(["arch", "behavior", "pref"]);
  });
});

describe("readOpenQuestions", () => {
  test("keeps id, question, recommended and grade", () => {
    const q = readOpenQuestions({
      open_questions: [
        {
          id: "Q1",
          question: "persist?",
          recommended: "no",
          grade: "behavior",
        },
      ],
    });
    expect(q).toEqual([
      { id: "Q1", question: "persist?", recommended: "no", grade: "behavior" },
    ]);
  });

  test("an unrecognised grade becomes behavior, and a missing id is positional", () => {
    const q = readOpenQuestions({
      open_questions: [{ question: "x", grade: "urgent" }],
    });
    expect(q[0]).toEqual({
      id: "Q1",
      question: "x",
      recommended: "",
      grade: "behavior",
    });
  });

  test("a row with no question text is dropped, there is nothing to ask", () => {
    expect(
      readOpenQuestions({ open_questions: [{ id: "Q1", recommended: "no" }] }),
    ).toEqual([]);
  });

  test("absent or malformed open_questions read as none", () => {
    expect(readOpenQuestions({})).toEqual([]);
    expect(readOpenQuestions({ open_questions: "x" })).toEqual([]);
    expect(readOpenQuestions(null)).toEqual([]);
  });
});

describe("derivedCount", () => {
  test("counts derived criteria plus open questions", () => {
    expect(
      derivedCount({
        acceptance_criteria: [
          { text: "a", source: "request" },
          { text: "b", source: "derived" },
        ],
        open_questions: [{ id: "Q1", question: "x" }],
      }),
    ).toBe(2);
  });

  test("a legacy ticket asks nothing", () => {
    expect(derivedCount({ acceptance_criteria: ["a", "b"] })).toBe(0);
  });
});
