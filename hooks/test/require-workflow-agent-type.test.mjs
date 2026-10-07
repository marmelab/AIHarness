// Tests for the workflow agentType guard.
//
// The behaviour under test was measured, not assumed: a workflow agent reaches the hooks
// as `workflow-subagent` without `agentType`, and as its real role with it. The guard
// refuses the first shape because nothing else will: the run succeeds, and only the gates
// are missing.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  agentCalls,
  check,
  untypedCalls,
} from "../require-workflow-agent-type.mjs";

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

/** A context that records the one verdict a guard can reach. */
const ctx = () => {
  const seen = { blocked: null, logs: [] };
  return {
    seen,
    block: ({ reason, log }) => {
      seen.blocked = reason;
      seen.logs.push(log);
    },
    log: (l) => seen.logs.push(l),
  };
};

const run = (script) => {
  const c = ctx();
  check({ tool_input: { script } }, c);
  return c.seen;
};

describe("untypedCalls", () => {
  test("a bare dispatch is reported", () => {
    expect(untypedCalls(`const r = await agent('do the thing')`)).toHaveLength(
      1,
    );
  });

  test("a dispatch that names its type is not", () => {
    expect(
      untypedCalls(
        `await agent('do it', { agentType: 'developer', label: 'x' })`,
      ),
    ).toEqual([]);
  });

  test("options held in a variable are left alone", () => {
    // Fail open on ignorance: the value is only known at run time, and refusing it would
    // be a guess rather than a finding.
    expect(
      untypedCalls(`const O = { agentType: 'developer' };
      await agent('do it', O)`),
    ).toEqual([]);
    expect(
      untypedCalls(`await agent('do it', { ...BASE, label: 'x' })`),
    ).toEqual([]);
  });

  test("a nested dispatch is judged on its own options, not its parent's", () => {
    // pipeline(xs, x => agent(...)) is the common shape, and the inner call is the one
    // that needs a type. The outer `agent` here has one; the inner does not.
    const src = `await agent('outer', { agentType: 'orchestrator' })
      await pipeline(xs, (x) => agent('inner: ' + x))`;
    const bad = untypedCalls(src);
    expect(bad).toHaveLength(1);
    expect(bad[0].preview).toContain("inner");
  });

  test("an identifier ending in agent is not a dispatch", () => {
    expect(untypedCalls(`subagent('x'); myAgent('y'); obj.agent('z')`)).toEqual(
      [],
    );
  });

  test("the word agent inside a string is not a dispatch", () => {
    expect(
      untypedCalls(
        `await agent('spawn an agent(x) for each file', { agentType: 'dev' })`,
      ),
    ).toEqual([]);
  });

  test("an unbalanced script is not judged", () => {
    expect(agentCalls(`await agent('oops'`)).toEqual([]);
  });
});

describe("check", () => {
  test("refuses an untyped dispatch, and says what to write instead", () => {
    const seen = run(`await agent('audit the routes')`);
    expect(seen.blocked).toContain("agentType");
    expect(seen.blocked).toContain("workflow-subagent");
    expect(seen.blocked).toContain("agentType: 'developer'");
  });

  test("allows a script where every dispatch names its type", () => {
    const seen = run(`
      const a = await agent('plan', { agentType: 'planner' })
      const b = await parallel([() => agent('dev', { agentType: 'developer' })])
    `);
    expect(seen.blocked).toBe(null);
  });

  test("an explicit general-purpose is an answer, not an omission", () => {
    // The guard asks for a decision, not for a harness role.
    const seen = run(
      `await agent('look around', { agentType: 'general-purpose' })`,
    );
    expect(seen.blocked).toBe(null);
  });

  test("reads a script passed by path", () => {
    TMP = mkdtempSync(join(tmpdir(), "wf-guard-"));
    const file = join(TMP, "wf.js");
    writeFileSync(file, `await agent('no type here')`);
    const c = ctx();
    check({ tool_input: { scriptPath: file } }, c);
    expect(c.seen.blocked).toContain("agentType");
  });

  test("a workflow run by name carries no source and is not judged", () => {
    // A saved or bundled workflow is reviewed when it is saved. Refusing it here would
    // block /deep-research on a script this hook never sees.
    const c = ctx();
    check({ tool_input: { name: "deep-research" } }, c);
    expect(c.seen.blocked).toBe(null);
  });

  test("an unreadable path is allowed rather than guessed at", () => {
    const c = ctx();
    check({ tool_input: { scriptPath: "/nope/missing.js" } }, c);
    expect(c.seen.blocked).toBe(null);
  });

  test("the refusal counts the sites and lists them", () => {
    const seen = run(`
      await agent('one')
      await agent('two')
      await agent('three', { agentType: 'developer' })
    `);
    expect(seen.blocked).toContain("2 agent() calls");
    expect(seen.logs[0]).toBe("BLOCK workflow with 2 untyped agent() call(s)");
  });
});
