#!/usr/bin/env node
/**
 * PreToolUse hook matcher: "Bash"
 *
 * Avoid blocking agents
 * State kept in a per-session temp file (no external dependency). Resets
 * after RESET_AFTER_MS.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_CALLS = Number(process.env.CIRCUIT_BREAKER_MAX_CALLS ?? 60);
const RESET_AFTER_MS = Number(process.env.CIRCUIT_BREAKER_RESET_MS ?? 60 * 60 * 1000); // 1h

function readStdin() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

const input = readStdin();
const sessionId = input?.session_id ?? "default";

const stateDir = join(tmpdir(), "claude-circuit-breaker");
if (!existsSync(stateDir)) mkdirSync(stateDir, { recursive: true });
const stateFile = join(stateDir, `${sessionId}.json`);

let state = { count: 0, firstCallAt: Date.now() };
if (existsSync(stateFile)) {
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    // corrupted file, start fresh
  }
}

const now = Date.now();
if (now - state.firstCallAt > RESET_AFTER_MS) {
  state = { count: 0, firstCallAt: now };
}

state.count += 1;
writeFileSync(stateFile, JSON.stringify(state));

if (state.count > MAX_CALLS) {
  console.error(
    `circuit-breaker: ${state.count} Bash calls in this session (threshold: ${MAX_CALLS}).\n` +
    `Stop and check in with the user before continuing: summarize what you're trying to ` +
    `solve and why it's taking this many iterations. The counter resets after ${Math.round(RESET_AFTER_MS / 60000)} min.`
  );
  process.exit(2);
}

process.exit(0);
