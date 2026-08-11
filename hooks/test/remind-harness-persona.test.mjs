// Tests for remind-harness-persona: the dispatch contract, restated at opt-in.
//
// A `#technical-harness` request once produced a run with no `PERSONA: technical` line in
// any agent prompt. The orchestrator ran as the default persona, wrote no progress log,
// and the status board had nothing to render — a hundred minutes with no live view, which
// read as two broken hooks rather than one missing line. The reminder exists so that line
// cannot go missing quietly; these tests exist so the reminder cannot go inert quietly.

import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const HOOK = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "remind-harness-persona.mjs",
);

const run = (prompt) => {
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: "test-1234",
      hook_event_name: "UserPromptSubmit",
      prompt,
    }),
    encoding: "utf8",
  });
  const out = r.stdout.trim();
  return {
    status: r.status,
    context: out ? JSON.parse(out).hookSpecificOutput.additionalContext : "",
  };
};

describe("remind-harness-persona", () => {
  test("#technical-harness is reminded of PERSONA, and told what its absence costs", () => {
    const { context } = run("#technical-harness add an importance field");
    expect(context).toContain("PERSONA: technical");
    // The reason has to travel with the rule, or it reads as ceremony and gets dropped.
    expect(context).toContain("harness-progress.log");
  });

  test("#harness gets the gate and session dir, but not the technical persona", () => {
    const { context } = run("#harness fix the import dialog");
    expect(context).toContain("GATE:");
    expect(context).toContain("session_dir");
    expect(context).not.toContain("PERSONA: technical");
  });

  test("talking about the harness is not opting into it", () => {
    expect(run("what does the harness do with a failed review?").context).toBe(
      "",
    );
    expect(run("rewrite the harness docs").context).toBe("");
  });

  test("it never blocks, whatever it is handed", () => {
    for (const prompt of ["#technical-harness x", "hello", ""])
      expect(run(prompt).status).toBe(0);
    // An unparseable payload is the case a reminder must survive most quietly.
    const r = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("");
  });
});
