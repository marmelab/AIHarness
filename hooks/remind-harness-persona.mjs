#!/usr/bin/env node
// UserPromptSubmit: when the user opts into the harness, restate what the dispatch owes.
//
// A `#technical-harness` request produced a run with no `PERSONA: technical` line anywhere
// in any agent prompt, so the orchestrator ran as the default persona: no
// `harness-progress.log`, and therefore nothing for `render-status` to render either. The
// user watched a hundred minutes of silence and it looked like two hooks had broken, when
// in fact one line had gone missing at dispatch.
//
// That line lives in prose the main thread has to remember across a long conversation, so
// it is the kind of instruction that fails quietly and at the worst moment. Restated here
// at the moment the intent is expressed, which is the only place it is unambiguous.
//
// It reminds; it never blocks. A prompt that mentions the harness while talking ABOUT it
// rather than asking for it is common, and refusing those would be worse than the miss.

import { readFileSync } from "node:fs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // unparseable payload: nothing to remind about, fail open
}

const prompt = String(input.prompt || "");
const technical = /#technical-harness/.test(prompt);
const plain = /#harness\b/.test(prompt);
if (!technical && !plain) process.exit(0);

const lines = [
  "The user opted into the agent harness. The orchestrator dispatch must carry, each on its own line:",
  "- `GATE: <none|migration|plan|waves>` — always explicit; it fails closed to `plan` on a missing value.",
  "- the `<session_dir>` for this session.",
];
if (technical)
  lines.push(
    "- `PERSONA: technical` — REQUIRED here. Without it the orchestrator runs the default persona, writes no `harness-progress.log`, and the status board has nothing to render: the whole run is invisible while it happens, and a past run lost its live view exactly this way.",
  );

process.stdout.write(
  `${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: `<harness_dispatch_contract>\n${lines.join("\n")}\n</harness_dispatch_contract>`,
    },
  })}\n`,
);
process.exit(0);
