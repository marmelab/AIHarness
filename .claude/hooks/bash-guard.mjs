#!/usr/bin/env node
/**
 * PreToolUse hook matcher: "Bash"
 *
 * Block some bash commands
 * Exit code 2 = blocks the call and returns the message to Claude (who can
 * rephrase). Exit 0 = allowed.
 */
import { readFileSync } from "node:fs";

const DANGEROUS_PATTERNS = [
  { re: /rm\s+-rf\s+(\/|\$HOME|~)(\s|$)/, reason: "recursive deletion on a root/home path" },
  { re: /git\s+push\s+.*--force/, reason: "force-push (can overwrite remote history)" },
  { re: /git\s+reset\s+--hard/, reason: "reset --hard (loss of local changes)" },
  { re: /curl[^|]*\|\s*(sh|bash)/, reason: "piping curl into a shell (running an unaudited script)" },
  { re: /chmod\s+-R?\s*777/, reason: "777 permissions (security risk)" },
  { re: /\bsudo\b/, reason: "privilege escalation" },
  { re: />\s*\.env(\.|$|\s)/, reason: "direct write to a .env file" },
  { re: /git\s+commit\s+.*--no-verify/, reason: "commit bypassing git hooks (--no-verify)" },
  { re: /npm\s+publish|yarn\s+publish|pnpm\s+publish/, reason: "package publish (irreversible action)" },
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

for (const { re, reason } of DANGEROUS_PATTERNS) {
  if (re.test(command)) {
    console.error(
      `bash-guard: command blocked (${reason}).\n` +
      `Command: ${command}\n` +
      `If this action is genuinely necessary, ask the user for explicit validation before continuing.`
    );
    process.exit(2);
  }
}

process.exit(0);
