// <session_dir>/e2e-result.json: the only place the e2e suite's verdict exists.
//
// Written by e2e-on-feature-review, read by the orchestrator before promotion and by
// completion-invariant, which rejects a stop that leaves it `failed`. The shape and the
// signature live here so a reader and the writer cannot drift.
//
//   status      passed | failed | skipped | running
//   sessionSha  the session-branch commit the suite ran against, so a reader can tell a
//               verdict about the code as it stands from one that predates later merges
//   failureSignature  which failure this is, not just that there was one (see below)

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sessionDirFromEnv } from "./config.mjs";

// Mirrors reviews.mjs: on a managed launcher the orchestrator's <session_dir> is the
// one config.launcher.sessionDirEnv names, not the recomputed /tmp/<repo>/<id> path, so
// the result has to land where the orchestrator will actually look for it.
export const e2eResultPath = (ctx) =>
  join(sessionDirFromEnv() || ctx.sessionDir, "e2e-result.json");

/** Parsed result, or null when absent/unreadable/malformed. */
export function readE2eResult(ctx) {
  const p = e2eResultPath(ctx);
  if (!existsSync(p)) return null;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

// A Playwright failure header names the spec:
//   1) [chromium] › e2e/deal-import.spec.ts:12:5 › import deals › shows the preview
const SPEC_IN_FAILURE = /^\s*\d+\)\s.*?([\w./-]+\.spec\.[cm]?[jt]sx?)/m;
const ANY_SPEC = /([\w./-]+\.spec\.[cm]?[jt]sx?)/;
// The first line of the failure body: `Error:`, `TimeoutError:`, `AssertionError:`, and
// the `expect(...) failed` form Playwright uses for a soft locator assertion.
const ERROR_LINE = /^\s*(?:[A-Za-z]*Error:.*|expect\(.*)$/;

/**
 * WHICH failure this is: a short hash of the first failing spec path plus its first error
 * line. Two runs failing the same way share a signature; a different bug produces a
 * different one.
 *
 * This is what lets a fix-round budget be spent per distinct failure instead of globally.
 * A global budget is spent by whichever failures come first, so a suite with three bugs
 * ships red on the third without ever having tried to fix it.
 *
 * "" when nothing recognisable is in the output: the caller then falls back to its global
 * cap rather than treating every unparseable run as the same failure.
 *
 * @param {string} output  The suite's combined output.
 * @returns {string}
 */
export function failureSignature(output) {
  const text = String(output ?? "");
  if (!text.trim()) return "";
  const lines = text.split("\n");

  const headerIdx = lines.findIndex((l) => SPEC_IN_FAILURE.test(l));
  const spec =
    headerIdx !== -1
      ? (lines[headerIdx].match(ANY_SPEC) || [])[1] || ""
      : (text.match(ANY_SPEC) || [])[1] || "";
  if (!spec) return "";

  // The first error line AFTER the header, so a failure inherits its own message rather
  // than one printed by an earlier, unrelated line.
  let error = "";
  for (let i = headerIdx + 1; i < lines.length && i <= headerIdx + 40; i++) {
    const line = lines[i].trim();
    if (ERROR_LINE.test(line)) {
      error = line;
      break;
    }
  }

  // Strip what varies between runs of the SAME failure: timings, ports, temp paths, and
  // the slot offset. Without this every re-run looks like a new bug and the per-signature
  // budget degrades back into a global one.
  const normalised = error
    .replace(/\b\d+(\.\d+)?m?s\b/g, "<t>")
    .replace(/:\d{4,5}\b/g, ":<port>")
    .replace(/\/tmp\/\S+/g, "<tmp>")
    .replace(/\s+/g, " ")
    .trim();

  return createHash("sha1")
    .update(`${spec}::${normalised}`)
    .digest("hex")
    .slice(0, 12);
}
