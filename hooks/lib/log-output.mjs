// Fold a captured tool's output into something hooks.log can hold.
//
// hooks.log has one grammar, `[timestamp] [hook] message`, and it is what makes the
// file greppable and machine-readable at all. Appending a compiler's or a test
// runner's raw stdout breaks it three ways at once: the continuation lines carry no
// timestamp and no hook name, the ANSI colour escapes make every grep and every diff
// of the file unreadable, and a single failing suite can contribute more lines than
// the rest of the session.
//
// The full output is NOT lost by truncating here: it goes to the agent verbatim on
// stderr (that is the channel it is written for) and, for a step that gave up, into
// <session_dir>/validation-gave-up/<task>. The log keeps the tail, which is where a
// compiler and a test runner both put the summary.

// CSI (colour, cursor moves), OSC (the title-setting escapes a progress spinner
// emits, terminated by BEL or ST), and the two-character escapes. Built from source
// strings rather than a literal so the control characters stay readable here.
const ANSI_RE = new RegExp(
  [
    "\\u001B\\[[0-9;?]*[ -/]*[@-~]",
    "\\u001B\\][\\s\\S]*?(?:\\u0007|\\u001B\\\\)",
    "\\u001B[@-Z\\\\-_]",
  ].join("|"),
  "g",
);

export const stripAnsi = (text) => String(text ?? "").replace(ANSI_RE, "");

/**
 * The loggable form of a captured output: no escapes, no blank noise, bounded.
 * @param {string} text
 * @param {{maxLines?: number, maxChars?: number}} [limits]
 * @returns {string} "" when there is nothing worth logging
 */
export function forLog(text, { maxLines = 12, maxChars = 900 } = {}) {
  const lines = stripAnsi(text)
    .split("\n")
    .map((l) => l.replace(/\s+$/, ""))
    .filter((l) => l.trim());
  if (!lines.length) return "";

  const dropped = Math.max(0, lines.length - maxLines);
  let out = lines.slice(-maxLines).join("\n");
  if (out.length > maxChars) out = `…${out.slice(-maxChars)}`;
  // Say what was cut, so a short log line is never mistaken for short output.
  return dropped ? `… ${dropped} earlier line(s) omitted\n${out}` : out;
}
