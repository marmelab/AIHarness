// The one-hour prompt cache TTL belongs to the orchestrator and to nothing else.
//
// The knob's sign flips per role: it pays for an agent that idles past the TTL, and costs
// money for one that does not. So "which agents declare it" IS the correctness of the
// change, and a well-meaning copy onto developer.md would be a silent regression.

import { describe, expect, test } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const AGENTS = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "agents",
);

/** The frontmatter block of an agent file: everything between the first two `---` lines. */
const frontmatter = (file) => {
  const body = readFileSync(join(AGENTS, file), "utf8");
  const m = body.match(/^---\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
};

/** The cacheTtl an agent declares, or "" when it declares none. */
const cacheTtl = (file) => {
  const fm = frontmatter(file);
  // `experimental:` opens a nested mapping; cacheTtl is its indented child.
  const m = fm.match(
    /^experimental:\s*\n(?:[ \t]+.*\n)*?[ \t]+cacheTtl:\s*(\S+)/m,
  );
  return m ? m[1] : "";
};

const FILES = readdirSync(AGENTS).filter((f) => f.endsWith(".md"));

describe("prompt cache TTL per agent", () => {
  test("the agent inventory is what this test thinks it is", () => {
    expect(FILES).toContain("orchestrator.md");
    expect(FILES).toContain("developer.md");
    expect(FILES).toContain("quality-reviewer.md");
    expect(FILES.length).toBeGreaterThanOrEqual(7);
  });

  test("the orchestrator declares the one-hour TTL", () => {
    expect(cacheTtl("orchestrator.md")).toBe("1h");
  });

  test("no other agent declares any TTL", () => {
    const others = FILES.filter((f) => f !== "orchestrator.md");
    const declared = others.filter((f) => cacheTtl(f) !== "");
    expect(
      declared,
      "a 1h TTL on an agent that never idles is pure loss, see the header",
    ).toEqual([]);
  });

  test("exactly one agent in the whole plugin carries the knob", () => {
    expect(FILES.filter((f) => cacheTtl(f) !== "")).toEqual([
      "orchestrator.md",
    ]);
  });

  test("the frontmatter says it is restricted, and what copying it costs", () => {
    // Two assertions, not five: pinning a comment's exact wording makes it unrewritable.
    const fm = frontmatter("orchestrator.md");
    expect(fm).toMatch(/THIS AGENT ONLY/);
    expect(fm).toMatch(/\$20\.10/);
  });
});
