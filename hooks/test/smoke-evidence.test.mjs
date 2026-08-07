// Tests for lib/smoke-evidence.mjs: recognising that a browser was actually driven.
//
// The calibration that matters: a real feature-smoke drove Chromium through Bash
// `node -e` scripts, with no MCP tool call anywhere. A check that accepts only the MCP
// shape would reject the honest case, so both shapes are asserted here.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import { browserEvidence, browserEvidenceIn } from "../lib/smoke-evidence.mjs";

const TMP = mkdtempSync(join(tmpdir(), "smoke-evidence-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const event = (name, input) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input }],
    },
  });

describe("browserEvidenceIn", () => {
  test("an MCP browser tool call is evidence", () => {
    const body = event("mcp__plugin_aiharness_playwright__browser_navigate", {
      url: "http://localhost:5399/#/contacts",
    });
    expect(browserEvidenceIn(body)).toMatchObject({ mcp: true, any: true });
  });

  test("a bare (non plugin-namespaced) MCP server name still counts", () => {
    const body = event("mcp__playwright__browser_snapshot", {});
    expect(browserEvidenceIn(body).mcp).toBe(true);
  });

  // The measured shape: no MCP tools in the tool list, so the reviewer drove the
  // browser from Bash. This must count, or an honest smoke is called a fake one.
  test.each([
    ["chromium.launch", "const b = await chromium.launch();"],
    ["page.goto", "await page.goto('http://localhost:5399/#/contacts');"],
    ["require('playwright')", "const { chromium } = require('playwright');"],
    ["import from playwright", "import { chromium } from 'playwright';"],
  ])("a Bash Playwright script is evidence: %s", (_label, snippet) => {
    const body = event("Bash", { command: `node -e "${snippet}"` });
    expect(browserEvidenceIn(body)).toMatchObject({ bash: true, any: true });
  });

  test("reading and grepping the source is NOT evidence", () => {
    const body = [
      event("Read", { file_path: "/wt/src/contacts/ContactList.tsx" }),
      event("Grep", { pattern: "contact-importance" }),
      event("Bash", { command: "git -C /wt log -p -1" }),
    ].join("\n");
    expect(browserEvidenceIn(body).any).toBe(false);
  });

  // Writing an e2e SPEC that mentions playwright is not driving a browser. The spec is
  // executed later by the suite, not by the smoke.
  test("mentioning playwright in prose is not enough on its own", () => {
    const body = event("Bash", { command: "ls node_modules/@playwright" });
    expect(browserEvidenceIn(body).any).toBe(false);
  });

  test("empty or absent input yields no evidence", () => {
    expect(browserEvidenceIn("").any).toBe(false);
    expect(browserEvidenceIn(undefined).any).toBe(false);
  });
});

describe("browserEvidence (file)", () => {
  test("reads a transcript and reports it was readable", () => {
    const p = join(TMP, "agent-1.jsonl");
    writeFileSync(p, event("Bash", { command: "await page.goto('/')" }));
    expect(browserEvidence(p)).toMatchObject({ any: true, readable: true });
  });

  // "Could not look" is a different claim from "did not drive a browser", and the
  // caller must be able to tell them apart before it judges anyone.
  test("a missing transcript is unreadable, not evidence of absence", () => {
    expect(browserEvidence(join(TMP, "nope.jsonl"))).toMatchObject({
      any: false,
      readable: false,
    });
    expect(browserEvidence("")).toMatchObject({ readable: false });
  });
});
