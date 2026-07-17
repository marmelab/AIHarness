#!/usr/bin/env node
/**
 * PostToolUse hook matcher: "Write|Edit"
 *
 * Use correct type
 *
 * Deliberately non-blocking (exit 1, not exit 2): flags rather than blocks,
 * to avoid breaking a legitimate flow (e.g. a documented `@ts-expect-error`).
 * Switch to exit 2 if the team wants a hard block.
 */
import { readFileSync } from "node:fs";

const SHORTCUT_PATTERNS = [
  { re: /\$TSFixMe\b/, label: "$TSFixMe" },
  { re: /:\s*any\b/, label: ": any" },
  { re: /as\s+any\b/, label: "as any" },
  { re: /@ts-ignore(?!\s*—|\s*:)/, label: "@ts-ignore without justification" },
];

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

const input = readStdin();
const filePath = input?.tool_input?.file_path;

if (!filePath || !/\.(ts|tsx)$/.test(filePath)) process.exit(0);

let content;
try {
  content = readFileSync(filePath, "utf8");
} catch {
  process.exit(0);
}

const hits = SHORTCUT_PATTERNS.filter(({ re }) => re.test(content)).map((p) => p.label);

if (hits.length > 0) {
  console.error(
    `check-typescript-shortcuts: ${filePath} contains a typing workaround (${hits.join(", ")}).\n` +
    `Replace it with the correct type instead of bypassing the typecheck.`
  );
  process.exit(1);
}

process.exit(0);
