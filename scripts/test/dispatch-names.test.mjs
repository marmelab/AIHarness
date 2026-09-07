// Every subagent_type literal in an agent prompt must name an agent the runtime can
// actually resolve.
//
// A plugin agent is reachable ONLY by its namespaced name. Measured on Claude Code 2.1.263:
// a plugin shipping an agent named `developer` refuses `subagent_type: "developer"` with
// `is_error: true` and `Agent type 'developer' not found. Available agents: …`, and accepts
// only `<plugin>:developer`. Bare names resolved up to 2.1.232, so this was silent for
// months: the orchestrator's 19 dispatch literals were all bare, and across nine benchmark
// runs it improvised the prefix 118 times out of 204 dispatches rather than reading it in
// its own prompt.
//
// This is a static test on purpose. The failure mode is a hard runtime error inside a
// dispatch, which costs a turn and is only visible in a transcript, so it must be caught
// here instead.

import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PLUGIN = JSON.parse(
  readFileSync(join(ROOT, ".claude-plugin", "plugin.json"), "utf8"),
).name;

const AGENT_FILES = readdirSync(join(ROOT, "agents")).filter((f) =>
  f.endsWith(".md"),
);

/** The `name:` each agent file declares, which is the half after the namespace. */
const declaredNames = AGENT_FILES.map((f) => {
  const m = readFileSync(join(ROOT, "agents", f), "utf8").match(
    /^name:\s*(\S+)/m,
  );
  return m ? m[1] : null;
}).filter(Boolean);

/** Every `subagent_type: "..."` literal in the agent prompts, with its file and line. */
const dispatchLiterals = AGENT_FILES.flatMap((f) => {
  const lines = readFileSync(join(ROOT, "agents", f), "utf8").split("\n");
  return lines.flatMap((line, i) => {
    const m = [...line.matchAll(/subagent_type:\s*"([^"]+)"/g)];
    return m.map((x) => ({ file: `agents/${f}`, line: i + 1, value: x[1] }));
  });
});

describe("dispatch names in the agent prompts", () => {
  test("the agent inventory is non-empty, or this whole file proves nothing", () => {
    expect(declaredNames).toContain("developer");
    expect(declaredNames).toContain("quality-reviewer");
    expect(dispatchLiterals.length).toBeGreaterThan(10);
  });

  test("every subagent_type literal carries the plugin namespace", () => {
    const bare = dispatchLiterals.filter((d) => !d.value.includes(":"));
    expect(
      bare.map((d) => `${d.file}:${d.line} -> ${d.value}`),
      "a bare name is rejected outright by the runtime, see the header",
    ).toEqual([]);
  });

  test("every subagent_type literal names an agent this plugin ships", () => {
    const valid = new Set(declaredNames.map((n) => `${PLUGIN}:${n}`));
    const unknown = dispatchLiterals.filter((d) => !valid.has(d.value));
    expect(
      unknown.map((d) => `${d.file}:${d.line} -> ${d.value}`),
      `known agents: ${[...valid].join(", ")}`,
    ).toEqual([]);
  });

  test("the namespace matches the plugin manifest rather than a hardcoded string", () => {
    // If the plugin is ever renamed, this fails instead of the templates going stale.
    for (const d of dispatchLiterals)
      expect(d.value.split(":")[0], `${d.file}:${d.line}`).toBe(PLUGIN);
  });

  test("the orchestrator prompt says a bare name is rejected", () => {
    // One assertion: the prompt has to tell the agent the prefix is mandatory. The
    // measurement behind it belongs in the commit message, not in a prompt the
    // orchestrator re-reads every turn.
    const prompt = readFileSync(
      join(ROOT, "agents", "orchestrator.md"),
      "utf8",
    );
    expect(prompt).toMatch(/Agent type 'developer' not found/);
  });
});
