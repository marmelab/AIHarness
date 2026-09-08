// Every subagent_type literal in an agent prompt must name an agent the runtime can
// resolve, which for a plugin agent means the namespaced name.
//
// Static on purpose: the failure is a hard error inside a dispatch, visible only in a
// transcript, so nothing downstream catches it.

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
    for (const d of dispatchLiterals)
      expect(d.value.split(":")[0], `${d.file}:${d.line}`).toBe(PLUGIN);
  });

  test("the orchestrator prompt says a bare name is rejected", () => {
    const prompt = readFileSync(
      join(ROOT, "agents", "orchestrator.md"),
      "utf8",
    );
    expect(prompt).toMatch(/Agent type 'developer' not found/);
  });
});
