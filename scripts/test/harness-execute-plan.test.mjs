// Tests for the workflow that replaces the orchestrator's STATE B.
//
// A workflow script cannot import anything: the runtime rejects a script containing
// import(), so every helper it uses is inlined. Rather than keep a second copy of the
// wave logic in a lib and let the two drift, these tests read `toWaves` out of the
// workflow file itself and exercise that. The file is the only copy.
//
// The rules under test are the ones STATE B parses by hand, and getting them wrong is
// silent: a ticket dispatched before its dependency merges builds on code that is not
// there yet, and the failure surfaces as a confusing review rejection much later.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "workflows", "harness-execute-plan.js");
const source = readFileSync(SCRIPT, "utf8");

/**
 * Lift one top-level function out of the workflow script and make it callable.
 *
 * `new Function` on a string is a code-injection shape, and it is safe only because of
 * where the string comes from: a file in this repository, read at test time, under the
 * same review as the test itself. Nothing here is user input or runtime data. The
 * alternative was a second copy of the wave rules in a lib, which is the defect this
 * avoids.
 */
const lift = (name) => {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`${name} is not in ${SCRIPT}`);
  let depth = 0;
  let i = source.indexOf("{", start);
  const open = i;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) break;
  }
  const body = source.slice(open, i + 1);
  const argsSrc = source.slice(source.indexOf("(", start) + 1, open).trim();
  const params = argsSrc.replace(/\)\s*$/, "");
  return new Function(params, body.slice(1, -1));
};

const toWaves = lift("toWaves");
const t = (id, dependencies = [], extra = {}) => ({
  id,
  dependencies,
  ...extra,
});
const ids = (waves) => waves.map((w) => w.map((x) => x.id));

describe("meta", () => {
  test("is a pure literal, or the workflow drops out of autocomplete", () => {
    const block = source.slice(
      source.indexOf("export const meta"),
      source.indexOf("}\n", source.indexOf("phases:")) + 2,
    );
    expect(block).not.toMatch(/\$\{/);
    expect(block).not.toMatch(/\.\.\./);
  });

  test("every phase() title has a meta entry", () => {
    const called = [...source.matchAll(/phase:\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    const declared = [...source.matchAll(/title:\s*['"]([^'"]+)['"]/g)].map(
      (m) => m[1],
    );
    for (const c of new Set(called)) expect(declared).toContain(c);
  });
});

describe("toWaves", () => {
  test("independent tickets share a wave", () => {
    expect(ids(toWaves([t("A"), t("B"), t("C")], 5))).toEqual([
      ["A", "B", "C"],
    ]);
  });

  test("a dependent ticket waits for the wave that merges its dependency", () => {
    const waves = toWaves([t("A"), t("B", ["A"]), t("C", ["B"])], 5);
    expect(ids(waves)).toEqual([["A"], ["B"], ["C"]]);
  });

  test("a ticket waits for ALL its dependencies, not the first", () => {
    const waves = toWaves([t("A"), t("B"), t("C", ["A", "B"])], 5);
    expect(ids(waves)).toEqual([["A", "B"], ["C"]]);
  });

  test("a ticket the planner marked unsafe takes a wave of its own", () => {
    // parallel_safe: false means its edits collide with anything running beside it.
    const waves = toWaves(
      [t("A"), t("B", [], { parallel_safe: false }), t("C")],
      5,
    );
    expect(ids(waves)).toEqual([["B"], ["A", "C"]]);
  });

  test("a wave is capped, and the rest become a later wave", () => {
    const many = ["A", "B", "C", "D", "E", "F", "G"].map((id) => t(id));
    expect(ids(toWaves(many, 5))).toEqual([
      ["A", "B", "C", "D", "E"],
      ["F", "G"],
    ]);
  });

  test("a dependency on a ticket outside the set does not stall the run", () => {
    // The planner can reference a ticket merged in an earlier session. Treating it as
    // unmet would wedge the whole wave on something that is already done.
    expect(ids(toWaves([t("A", ["TASK-999"])], 5))).toEqual([["A"]]);
  });

  test("a dependency cycle is refused, not looped on", () => {
    expect(() => toWaves([t("A", ["B"]), t("B", ["A"])], 5)).toThrow(
      /unsatisfiable/,
    );
  });

  test("every ticket lands in exactly one wave", () => {
    const set = [t("A"), t("B", ["A"]), t("C", ["A"]), t("D", ["B", "C"])];
    const flat = toWaves(set, 5)
      .flat()
      .map((x) => x.id);
    expect(flat.sort()).toEqual(["A", "B", "C", "D"]);
  });
});

describe("the script's shape", () => {
  test("every dispatch names its agentType", () => {
    // Without it the agent reaches the hooks as `workflow-subagent` and every guard
    // keyed on the role goes quiet. require-workflow-agent-type refuses such a script;
    // this keeps the one we ship from ever reaching it.
    const calls = [...source.matchAll(/\bagent\(/g)];
    const types = [...source.matchAll(/agentType:\s*['"]([^'"]+)['"]/g)];
    expect(types.length).toBe(calls.length);
    for (const [, type] of types) expect(type).toMatch(/^aiharness:/);
  });

  test("merges are not run through pipeline or parallel", () => {
    // They share one branch and one worktree, so they serialise. A pipeline around the
    // merge stage would be a silent corruption rather than a failure.
    const mergeCall = source.slice(source.indexOf("mergePrompt(r.ticket)"));
    expect(mergeCall.slice(0, 200)).not.toMatch(/pipeline|parallel/);
  });

  test("it uses pipeline, not parallel, for develop and review", () => {
    // The barrier is what STATE B measured at 3 minutes 46 seconds of a held ticket.
    expect(source).toMatch(/await pipeline\(wave/);
    expect(source).not.toMatch(/await parallel\(wave/);
  });

  test("no forbidden clock or randomness, which would break resume", () => {
    expect(source).not.toMatch(/Date\.now\(\)|Math\.random\(\)|new Date\(\)/);
  });
});
