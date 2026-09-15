// Tests for check-typescript-shortcuts.mjs, a non-blocking PostToolUse(Write|Edit) flag.
// It scans the written .ts/.tsx file for typing escape hatches and, when it finds one,
// exits 0 with the warning on stdout as `additionalContext`.
//
// It used to exit 1 with the warning on stderr, and passed these tests doing so. So
// "flagged" is now defined by the stdout contract, not by the exit code.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, test, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "check-typescript-shortcuts.mjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "ts-shortcuts-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

// Write `source` to a file named `name`, then run the hook against it. The payload
// carries `content`, the way the runtime's own Write payload does: this hook judges what
// the tool WROTE, so a fixture that only puts the text on disk exercises a different hook.
const runHook = (name, source, toolInput) => {
  const filePath = join(tmpRoot, name);
  writeFileSync(filePath, source);
  const input = JSON.stringify({
    tool_name: "Write",
    session_id: "test-1234",
    tool_input: { file_path: filePath, content: source, ...toolInput },
  });
  return spawnSync("node", [HOOK], { input, encoding: "utf8" });
};

/** The message the agent receives, or "" when the hook said nothing. */
const flagMessage = (r) => {
  if (!r.stdout.trim()) return "";
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
};
const isFlagged = (r) => flagMessage(r) !== "";

describe("check-typescript-shortcuts hook", () => {
  describe("typing escape hatches → flagged", () => {
    const flagged = [
      ["as-any.ts", "const x = value as any;"],
      ["colon-any.ts", "let count: any = 0;"],
      ["tsfixme.ts", "type T = $TSFixMe;"],
      ["bare-ts-ignore.ts", "// @ts-ignore\nconst y = z.foo;"],
      ["bare-ts-expect-error.tsx", "// @ts-expect-error\nreturn <div/>;"],
    ];

    test.each(flagged)("%s → flagged", (name, source) => {
      const r = runHook(name, source);
      expect(isFlagged(r)).toBe(true);
      expect(flagMessage(r)).toMatch(/typing workaround/);
    });

    test.each(flagged)(
      "%s → warns without blocking the write",
      (name, source) => {
        const r = runHook(name, source);
        expect(r.status).toBe(0);
        expect(r.stderr).toBe("");
      },
    );
  });

  describe("clean or justified code → not flagged (silent)", () => {
    const clean = [
      ["typed.ts", "const x: number = 1;\nconst s: string = 'ok';"],
      [
        "justified.ts",
        "// @ts-expect-error legacy API returns an untyped payload\nconst y = z.foo;",
      ],
      ["anyword.ts", "const anything: string = 'not a match';"],
    ];

    test.each(clean)("%s → not flagged", (name, source) => {
      const r = runHook(name, source);
      expect(r.status).toBe(0);
      expect(isFlagged(r)).toBe(false);
    });
  });

  test("non-TS file → ignored", () => {
    const r = runHook("notes.md", "this has as any inside prose");
    expect(r.status).toBe(0);
    expect(isFlagged(r)).toBe(false);
  });

  test("unparseable payload → fails open (exit 0, silent)", () => {
    const r = spawnSync("node", [HOOK], {
      input: "not json",
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(isFlagged(r)).toBe(false);
  });

  test("echoes the payload's event name back, so the runtime accepts the output", () => {
    const filePath = join(tmpRoot, "event.ts");
    writeFileSync(filePath, "const x = value as any;");
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        tool_name: "Edit",
        session_id: "test-1234",
        hook_event_name: "PostToolUse",
        tool_input: {
          file_path: filePath,
          new_string: "const x = value as any;",
        },
      }),
      encoding: "utf8",
    });
    expect(JSON.parse(r.stdout).hookSpecificOutput.hookEventName).toBe(
      "PostToolUse",
    );
  });

  // The flag is about the change, not about the file it landed in. Reporting a legacy
  // module's existing `any`s on every edit to it says nothing about what the agent did,
  // and a warning that is usually wrong is one the agent learns to skip.
  describe("it judges the written text, not the file around it", () => {
    const LEGACY = "let legacy: any = 1;\nconst other = x as any;\n";

    test("an edit that adds clean code to a file full of `any` is not flagged", () => {
      const r = runHook("legacy-edit.ts", LEGACY, {
        content: undefined,
        new_string: "const total: number = items.length;",
      });
      expect(isFlagged(r)).toBe(false);
    });

    test("an edit that ADDS the shortcut is flagged, in that same file", () => {
      const r = runHook("legacy-add.ts", LEGACY, {
        content: undefined,
        new_string: "const total = items as any;",
      });
      expect(flagMessage(r)).toMatch(/as any/);
    });

    test("a MultiEdit is judged on the text of its edits", () => {
      const r = runHook("multi.ts", LEGACY, {
        content: undefined,
        edits: [
          { new_string: "const a: number = 1;" },
          { new_string: "const b = c as any;" },
        ],
      });
      expect(flagMessage(r)).toMatch(/as any/);
    });

    test("a payload that says nothing about what was written flags nothing", () => {
      const r = runHook("no-text.ts", LEGACY, { content: undefined });
      expect(isFlagged(r)).toBe(false);
    });
  });
});
