import { existsSync } from "node:fs";
import { join } from "node:path";
import { exec } from "./process.mjs";

// APP_DIR / CLAUDE_PROJECT_DIR override the detected root (used by hook tests).
function getRepo() {
  if (process.env.APP_DIR) return process.env.APP_DIR;
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const top = exec("git", ["rev-parse", "--show-toplevel"]);
  if (top.status === 0 && top.stdout.trim()) return top.stdout.trim();
  return process.cwd();
}

export const REPO = getRepo();

export const CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || "/root", ".claude");
export const TMP_ROOT = process.env.HARNESS_TMP_ROOT || "/tmp";

export function sanitizePath(p) {
  return String(p ?? "").replace(/\//g, "_");
}

// Resolve a file the HARNESS owns (a script, an adapter asset) in either layout: the
// harness installed as a plugin, where CLAUDE_PLUGIN_ROOT points at it, or copied into
// a project's .claude/. Checked in that order, falling back to the project path so the
// caller always gets something to report a missing file against.
export function harnessFile(...parts) {
  const roots = [process.env.CLAUDE_PLUGIN_ROOT, join(REPO, ".claude")].filter(
    Boolean,
  );
  for (const root of roots) {
    const candidate = join(root, ...parts);
    if (existsSync(candidate)) return candidate;
  }
  return join(roots[roots.length - 1], ...parts);
}
