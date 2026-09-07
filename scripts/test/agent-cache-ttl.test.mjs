// The one-hour prompt cache TTL belongs to the orchestrator and to nothing else.
//
// This is a cost knob with a sign that flips per role. A 1h cache write bills 2x input
// where the 5-minute default bills 1.25x, so it pays only for an agent that idles past the
// TTL between turns and then re-writes its whole context instead of reading it.
//
// Measured with scripts/session-cost.mjs across the nine benchmark runs: 41 turns did that
// re-write, and all 41 are orchestrator turns. None of the 60 developers, 71 reviewers, 43
// mergers, 9 planners or 2 test-writers has a single one, because none of them waits on a
// child. Modelled on the same runs, the knob is worth +$5.21 on the orchestrator and
// -$20.10 on everyone else; set globally it costs $14.89 more than the default.
//
// So "which agents declare it" is the whole correctness of the change, and a well-meaning
// copy of the frontmatter block into developer.md would silently make the harness more
// expensive with nothing to show for it. Hence a test that counts.

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
    // The next reader's first instinct is to copy the block onto the expensive agents, so
    // the restriction and the price of ignoring it have to be where they will look. Two
    // assertions, not five: pinning the exact wording of a comment makes it unrewritable.
    const fm = frontmatter("orchestrator.md");
    expect(fm).toMatch(/THIS AGENT ONLY/);
    expect(fm).toMatch(/\$20\.10/);
  });
});
