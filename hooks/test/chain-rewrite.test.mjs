// Tests for the input-rewrite channel in the guard chain.
//
// The chain runs every PreToolUse(Agent) guard in one process and setup-worktree runs
// LAST, so a guard that corrected a dispatch by writing its JSON and exiting would create
// no worktree and the dispatch would fail on something unrelated to what it fixed. Hence
// ctx.rewriteInput RETURNS, the chain accumulates, and one updatedInput is emitted after
// the last guard.
//
// The other half is that later guards must see the corrected call. A chain where guard 8
// gates a value guard 7 already changed is a bug with a long fuse.

import { describe, expect, test } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch } from "../lib/context.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const LIB = join(HERE, "..", "lib");

/** Build and run a throwaway chain whose guard bodies are supplied as source. */
const runChainWith = (guardBodies, toolInput) => {
  const dir = mkdtempSync(join(tmpdir(), "chain-rewrite-"));
  const script = join(dir, "chain.mjs");
  const guards = guardBodies
    .map((body, i) => `["g${i}", (input, ctx) => { ${body} }]`)
    .join(",\n  ");
  writeFileSync(
    script,
    `import { runChain } from ${JSON.stringify(join(LIB, "hook-chain.mjs"))};\n` +
      `runChain([\n  ${guards}\n]);\n`,
  );
  const r = spawnSync("node", [script], {
    input: JSON.stringify({
      session_id: "chain-rewrite-test",
      hook_event_name: "PreToolUse",
      tool_name: "Agent",
      tool_input: toolInput,
    }),
    encoding: "utf8",
  });
  rmSync(dir, { recursive: true, force: true });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    updated: r.stdout.trim()
      ? JSON.parse(r.stdout).hookSpecificOutput.updatedInput
      : null,
  };
};

const DISPATCH = {
  subagent_type: "aiharness:quality-reviewer",
  prompt: "ROLE: x",
};

describe("applyPatch", () => {
  test("adds and replaces keys", () => {
    expect(applyPatch({ a: 1 }, { a: 2, b: 3 })).toEqual({ a: 2, b: 3 });
  });

  test("an explicit undefined REMOVES the key, which is how a default is restored", () => {
    expect(applyPatch({ model: "sonnet", a: 1 }, { model: undefined })).toEqual(
      { a: 1 },
    );
  });

  test("returns a new object rather than mutating the payload every later guard reads", () => {
    const base = { a: 1 };
    const out = applyPatch(base, { b: 2 });
    expect(base).toEqual({ a: 1 });
    expect(out).not.toBe(base);
  });

  test("survives a missing base or patch", () => {
    expect(applyPatch(undefined, { a: 1 })).toEqual({ a: 1 });
    expect(applyPatch({ a: 1 }, undefined)).toEqual({ a: 1 });
  });
});

describe("runChain with a rewriting guard", () => {
  test("emits nothing when no guard rewrote anything", () => {
    const r = runChainWith([`ctx.allow("nothing to do");`], DISPATCH);
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
  });

  test("emits one updatedInput after the last guard", () => {
    const r = runChainWith(
      [`ctx.rewriteInput({ model: "sonnet" });`, `ctx.allow("later guard");`],
      DISPATCH,
    );
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.updated.model).toBe("sonnet");
  });

  test("does NOT end the chain, so setup-worktree still gets to run", () => {
    // The whole reason rewriteInput returns instead of exiting.
    const r = runChainWith(
      [
        `ctx.rewriteInput({ model: "sonnet" });`,
        `ctx.error("LATER_GUARD_RAN");`,
      ],
      DISPATCH,
    );
    expect(r.stderr).toContain("LATER_GUARD_RAN");
    expect(r.updated.model).toBe("sonnet");
  });

  test("a later guard sees the corrected input, not the original", () => {
    const r = runChainWith(
      [
        `ctx.rewriteInput({ model: "sonnet" });`,
        `ctx.error("SAW=" + input.tool_input.model);`,
      ],
      DISPATCH,
    );
    expect(r.stderr).toContain("SAW=sonnet");
  });

  test("two guards' patches are merged into one emission", () => {
    const r = runChainWith(
      [
        `ctx.rewriteInput({ model: "sonnet" });`,
        `ctx.rewriteInput({ name: "r1" });`,
      ],
      DISPATCH,
    );
    expect(r.stdout.trim().split("\n")).toHaveLength(1);
    expect(r.updated).toMatchObject({ model: "sonnet", name: "r1" });
  });

  test("the last guard to touch a key wins", () => {
    const r = runChainWith(
      [
        `ctx.rewriteInput({ model: "sonnet" });`,
        `ctx.rewriteInput({ model: undefined });`,
      ],
      DISPATCH,
    );
    expect(r.updated).not.toHaveProperty("model");
  });

  test("the untouched fields of the dispatch are carried through", () => {
    const r = runChainWith([`ctx.rewriteInput({ model: "sonnet" });`], {
      ...DISPATCH,
      description: "Review TASK-007",
    });
    expect(r.updated.subagent_type).toBe("aiharness:quality-reviewer");
    expect(r.updated.description).toBe("Review TASK-007");
    expect(r.updated.prompt).toBe("ROLE: x");
  });

  test("a refusal after a rewrite wins, and no updatedInput is emitted", () => {
    // ctx.fail ends the process. A denied call must not be handed a corrected input as
    // though it were going ahead.
    const r = runChainWith(
      [`ctx.rewriteInput({ model: "sonnet" });`, `ctx.fail("denied");`],
      DISPATCH,
    );
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
  });

  test("a guard that crashes does not lose an earlier guard's rewrite", () => {
    const r = runChainWith(
      [
        `ctx.rewriteInput({ model: "sonnet" });`,
        `throw new Error("BOOM");`,
        `ctx.allow("still running");`,
      ],
      DISPATCH,
    );
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("BOOM");
    expect(r.updated.model).toBe("sonnet");
  });
});
