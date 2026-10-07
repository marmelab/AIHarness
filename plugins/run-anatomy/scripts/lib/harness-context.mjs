// What a session knows about the harness that ran it, if any.
//
// Two facts change how a session is read: which subagents are harness roles (only those
// open a run window) and which shell commands are the project's validation (they get their
// own activity). Both come from the project's harness.config.json, and the project is the
// SESSION's, not the one the script runs from: a report over every project must not read
// one project's sessions through another's config.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The plugin whose namespaced agents are harness roles whatever a config says. */
export const HARNESS_PLUGIN = "aiharness";

/**
 * The directory the session ran in: the first `cwd` its transcript records.
 *
 * Walks line by line rather than splitting the body, which can run to tens of megabytes
 * while the answer is almost always on the first lines.
 *
 * @param {string} body the main transcript
 * @returns {string | null}
 */
export function sessionCwd(body) {
  const text = String(body ?? "");
  let from = 0;
  while (from < text.length) {
    const end = text.indexOf("\n", from);
    const line = text.slice(from, end === -1 ? text.length : end);
    from = end === -1 ? text.length : end + 1;
    if (!line.includes('"cwd"')) continue;
    try {
      const cwd = JSON.parse(line).cwd;
      if (typeof cwd === "string" && cwd) return cwd;
    } catch {
      /* a torn line costs nothing: the next one carries the same field */
    }
  }
  return null;
}

/**
 * The harness config that applies to a session: the one named explicitly, else the one in
 * the directory the session ran in. Null when there is none, or when it does not parse: a
 * malformed config must not stop an ingest, since the generic rules still apply.
 *
 * @param {{explicit?: string | null, cwd?: string | null}} where
 * @returns {object | null}
 */
export function harnessConfigFor({ explicit = null, cwd = null }) {
  const file = explicit || (cwd ? join(cwd, "harness.config.json") : null);
  if (!file || !existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/**
 * The bare roles that open a run window: those the config declares, plus every role this
 * session dispatched under the harness plugin's namespace, so a session whose config is
 * gone, or predates a role, still recognises a harness agent.
 *
 * @param {object | null} config
 * @param {{meta?: {agentType?: string}}[]} agents
 * @returns {Set<string>}
 */
export function harnessRoles(config, agents) {
  const roles = new Set(Object.keys(config?.roles || {}));
  const prefix = `${HARNESS_PLUGIN}:`;
  for (const { meta } of agents) {
    const type = String(meta?.agentType || "");
    if (type.startsWith(prefix)) roles.add(type.slice(prefix.length));
  }
  return roles;
}
