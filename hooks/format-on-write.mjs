#!/usr/bin/env node
// PostToolUse(Write|Edit): format the file just written, using the formatter and
// extension list from harness.config.json's format-kind validation step. This is
// the human/main-thread convenience: harness subagents are SKIPPED because their
// SubagentStop validation chain already applies the format step (and would
// re-run it), so formatting their in-flight writes is redundant churn.
//
// Non-blocking: the Write already succeeded, so a formatter failure only warns. The warning
// goes out as additionalContext with exit 0, because exit 1 puts it on a channel the model
// never reads (see lib/io.mjs) and the model is the only party that can act on it.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { loadConfig, formatStep } from "./lib/config.mjs";
import { additionalContext } from "./lib/io.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0);
}

// Skip harness subagents (they carry an agent_type / runtime agent name);
// validate-on-stop covers them.
if (input.agent_type || process.env.CLAUDE_AGENT_NAME) process.exit(0);

const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

let step;
try {
  step = formatStep(loadConfig());
} catch {
  process.exit(0); // no readable config -> nothing to do
}
if (!step || !step.formatter) process.exit(0);

const exts = step.extensions ?? [];
if (exts.length && !exts.some((e) => filePath.endsWith(e))) process.exit(0);

const [bin, ...baseArgs] = step.formatter.split(/\s+/).filter(Boolean);
try {
  execFileSync(bin, [...baseArgs, filePath], {
    stdio: "ignore",
    timeout: 15_000,
  });
} catch (err) {
  additionalContext(
    input.hook_event_name,
    `[format-on-write] failed to format ${filePath}: ${err.message}`,
  );
}
process.exit(0);
