// Did a feature-smoke actually drive a browser?
//
// A smoke's whole value is that something RAN. An APPROVED smoke with no browser
// activity in its transcript is a verdict inferred from source, and it is the one
// failure this check exists to catch: nothing else in the pipeline can tell a walked
// flow from a read one.
//
// Two shapes count as evidence, and BOTH must, because the harness uses both:
//
//   - an `mcp__…__browser_*` tool call, when the runtime delivers the Playwright MCP
//     tools to the subagent;
//   - a Bash command driving Playwright directly (`chromium.launch()`, `page.goto()`,
//     `require('playwright')`), which is what an agent does when those tools are not
//     in its tool list.
//
// Accepting only the MCP shape would reject an honest smoke that drove a real browser
// from Bash, which is the more common of the two.

import { existsSync, readFileSync } from "node:fs";

// The MCP browser tools, under any server namespace (plugin-namespaced or bare).
const MCP_BROWSER_TOOL =
  /"mcp__[\w.-]*browser_(navigate|click|type|snapshot|fill_form|select_option|press_key|take_screenshot|console_messages)"/;
// A Bash command driving a browser through the Playwright library or CLI.
const BASH_BROWSER_DRIVE =
  /(chromium|firefox|webkit)\s*\.\s*launch|page\s*\.\s*goto|browserType|require\(['"]playwright|from ['"]playwright|playwright\s+screenshot/;

/**
 * Scan a transcript body for evidence that a browser was driven.
 * @param {string} body raw JSONL transcript
 * @returns {{ mcp: boolean, bash: boolean, any: boolean }}
 */
export function browserEvidenceIn(body) {
  const text = String(body ?? "");
  const mcp = MCP_BROWSER_TOOL.test(text);
  const bash = BASH_BROWSER_DRIVE.test(text);
  return { mcp, bash, any: mcp || bash };
}

/**
 * Same, for an agent's own transcript file. A missing or unreadable transcript
 * yields no evidence AND says so, so a caller can tell "did not drive a browser"
 * from "could not look" and refrain from acting on the second.
 * @param {string} transcriptPath
 * @returns {{ mcp: boolean, bash: boolean, any: boolean, readable: boolean }}
 */
export function browserEvidence(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) {
    return { mcp: false, bash: false, any: false, readable: false };
  }
  try {
    const body = readFileSync(transcriptPath, "utf8");
    return { ...browserEvidenceIn(body), readable: true };
  } catch {
    return { mcp: false, bash: false, any: false, readable: false };
  }
}
