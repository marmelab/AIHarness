// The developer's output contract, parsed from its final line.
//
// Lives here rather than in record-developer-done.mjs so it is testable: a hook module
// reads its payload with a top-level `readFileSync(0)`, so importing one to reach its
// parser blocks on stdin forever. Same reason parseVerdict lives in verdict.mjs.

/**
 * Parse the developer's output contract (rules/agent-output-format.md):
 *   `DONE: branch=<b> commit=<sha> files=[<paths>]`
 *   `FAILED: <one-line reason>`
 *
 * Read bottom-up and take the first clean marker, matching parseVerdict's discipline: the
 * contract line is the LAST line, and a chatty trailer must not be able to flip a real
 * result. Both markers require the contract colon, so prose that merely mentions "done" or
 * "failed" is ignored -- a wrong line in the user's live feed is worse than no line, and
 * the orchestrator learns the real result from the dispatch's return value either way.
 *
 * @param {string} text
 * @returns {{ result: "DONE" | "FAILED", detail: string } | null}
 */
export function parseDeveloperContract(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((s) => s.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    const done = line.match(/^DONE:\s*(.*)$/);
    if (done) return { result: "DONE", detail: done[1].trim() };
    const failed = line.match(/^FAILED:\s*(.*)$/);
    if (failed) return { result: "FAILED", detail: failed[1].trim() };
  }
  return null;
}
