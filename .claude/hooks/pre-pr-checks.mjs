#!/usr/bin/env node
/**
 * PreToolUse hook matcher: "Bash"
 *
 * Make verification before creation of PR
 *
 * Adapt PR_TRIGGER_RE and the check commands to the project's stack.
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const PR_TRIGGER_RE = /\bgh\s+pr\s+create\b|\bgit\s+push\b/;

const CHECKS = [
  { label: "typecheck", cmd: "npx tsc --noEmit" },
  { label: "lint", cmd: "npx eslint . --max-warnings=0" },
  // { label: "dead-code", cmd: "npx knip" }, // uncomment if knip is configured on the project
];

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

const input = readStdin();
const command = input?.tool_input?.command ?? "";

if (!PR_TRIGGER_RE.test(command)) process.exit(0);

const failures = [];
for (const { label, cmd } of CHECKS) {
  try {
    execSync(cmd, { stdio: "pipe", timeout: 120_000 });
  } catch (err) {
    failures.push(`- ${label} (\`${cmd}\`) failed:\n${(err.stdout?.toString() || err.message).slice(0, 800)}`);
  }
}

if (failures.length > 0) {
  console.error(
    `pre-pr-checks: the PR/push was blocked, ${failures.length} check(s) failed before continuing:\n\n` +
    failures.join("\n\n") +
    `\n\nFix the issues above before retrying.`
  );
  process.exit(2);
}

process.exit(0);
