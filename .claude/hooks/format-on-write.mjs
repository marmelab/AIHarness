#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

const input = readStdin();
const filePath = input?.tool_input?.file_path;

if (!filePath) process.exit(0);
if (!/\.(ts|tsx|js|jsx|json|css|md)$/.test(filePath)) process.exit(0);

try {
  // Adapt to your stack: `npx prettier --write`, `npx biome format --write`, etc.
  execFileSync("npx", ["prettier", "--write", filePath], {
    stdio: "ignore",
    timeout: 15_000,
  });
} catch (err) {
  // Never block the agent over a formatting issue: flag it via non-blocking
  // output (exit 1), Claude will see the message but the original tool call
  // already succeeded.
  console.error(`format-on-write: failed to format ${filePath}: ${err.message}`);
  process.exit(1);
}

process.exit(0);
