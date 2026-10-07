// Where this plugin reads from and writes to.
//
// The plugin is installed from its own directory, so it cannot reach anything outside it:
// these are resolved here rather than borrowed from the harness.

import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// CLAUDE_PROJECT_DIR overrides the detected root.
function getRepo() {
  if (process.env.CLAUDE_PROJECT_DIR) return process.env.CLAUDE_PROJECT_DIR;
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (top.status === 0 && top.stdout.trim()) return top.stdout.trim();
  return process.cwd();
}

/** The project the scripts run from: where `.runs/` lives by default. */
export const REPO = getRepo();

export const CONFIG_DIR =
  process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME || "/root", ".claude");

/** Throwaway pages and stores, never the archive. */
export const TMP_ROOT = join(
  process.env.SESSIONS_STATS_TMP_ROOT || tmpdir(),
  "sessions-stats",
);
