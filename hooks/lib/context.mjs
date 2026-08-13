// Build a hook context from a hook's stdin payload: identity, session-scoped
// paths, a logger, and terminal accept/block/fail helpers. The `name` is the
// hook's label; log() and error() prefix every line with `[name]`, and
// accept/block/fail add the `ACCEPT|BLOCK|FAIL` verb on top — so call sites pass
// only the detail and never repeat the name.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { decisionBlock } from "./io.mjs";
import { REPO, TMP_ROOT, sanitizePath } from "./paths.mjs";
import { exec } from "./process.mjs";
import { loadConfig, sessionDirFromEnv, worktreeProvision } from "./config.mjs";

/**
 * @param {string | Record<string, unknown>} input
 * @param {string} [name]
 * @returns {object}
 */
export function createHookContext(input, name = "hook") {
  const i = typeof input === "string" ? JSON.parse(input) : input || {};
  const clean = (s) => String(s ?? "").replace(/[\t\n]/g, " ");

  const agentId = clean(i.agent_id);
  // agentName: env var carries the suffixed runtime name (e.g. developer-TASK-001)
  // in PostToolUse/PreToolUse contexts; for SubagentStart the env is the parent's,
  // so fall back to i.agent_name which Claude Code populates with the child's name.
  const agentName = process.env.CLAUDE_AGENT_NAME || clean(i.agent_name) || "";
  const launcherSessionDir = sessionDirFromEnv();
  const chatSessionId = launcherSessionDir ? basename(launcherSessionDir) : "";

  // Every piece of session state is keyed on this id: the breaker counters, the review
  // verdict flags, the validation give-up markers, the worktree base. A shared fallback
  // is therefore not a default, it is a collision: two contexts that both fail to
  // resolve an id land in the same /tmp/<repo>/default/, where one session's breaker
  // budget throttles another's agent and one session's APPROVED flag lets another's
  // merger through.
  //
  // The refusal is on the STATE, not on the context. Several hooks legitimately need no
  // session state at all (restrict-documentator-write and -bash only report a refusal
  // on stderr), and refusing them a context for want of an id they never use would take
  // guards offline to protect markers they never touch. So every session-scoped member
  // below is a getter that throws when there is no id, and reading one is the thing
  // that fails.
  const sessionId =
    clean(i.session_id) ||
    process.env.CLAUDE_CODE_SESSION_ID ||
    chatSessionId ||
    "";
  const requireSessionId = () => {
    if (sessionId) return sessionId;
    throw new Error(
      `${name}: no session id (payload session_id, CLAUDE_CODE_SESSION_ID and the ` +
        `launcher session dir are all empty), so there is no session state to key on. ` +
        `Every marker is keyed on it, and a shared fallback would mix two unrelated ` +
        `sessions' breaker counters and review verdicts.`,
    );
  };
  const agentType = clean(i.agent_type) || agentName;

  const sessionDirOf = () =>
    join(TMP_ROOT, sanitizePath(REPO), requireSessionId());

  /**
   * Append to hooks.log. EVERY line gets the `[timestamp] [hook]` prefix, including
   * the continuation lines of a multi-line message: a captured compiler or test
   * output pasted in raw used to leave hundreds of lines with no timestamp and no
   * hook name, which is what the file's whole grammar is for. Callers pass captured
   * output through lib/log-output.mjs forLog() first, so it is also stripped of ANSI
   * escapes and bounded.
   * @param {...unknown} parts
   * @returns {void}
   */
  const log = (...parts) => {
    const stamp = `[${new Date().toISOString()}] [${name}] `;
    const text =
      parts
        .join(" ")
        .split("\n")
        .map((line) => `${stamp}${line}`)
        .join("\n") + "\n";
    // hooks.log is itself session-scoped, so with no id there is nowhere to put this.
    // stderr rather than silence: a hook running without a session identity is a
    // misconfiguration worth seeing, and dropping the line would hide it.
    if (!sessionId) {
      try {
        process.stderr.write(text);
      } catch {
        // logging must never break a hook
      }
      return;
    }
    try {
      const logFile = join(sessionDirOf(), "hooks.log");
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, text);
    } catch {
      // logging must never break a hook
    }
  };

  /**
   * Write to stderr (the agent-visible channel), prefixed with `[${name}]` the
   * same way log() prefixes each log line. The prefix is added once, so
   * multi-line payloads (compiler/test output) stay readable; a trailing
   * newline is ensured.
   * @param {...unknown} parts
   * @returns {void}
   */
  const error = (...parts) => {
    const text = parts.join(" ");
    process.stderr.write(`[${name}] ${text}${text.endsWith("\n") ? "" : "\n"}`);
  };

  const verdict = (verb, detail) => log(detail ? `${verb} ${detail}` : verb);

  // The `npm-link` provisioning builtin: mirror $REPO/node_modules into the
  // worktree. See provisionWorktree below for the config-driven dispatcher.
  const linkNodeModules = (wt) => {
    const target = join(wt, "node_modules");
    if (existsSync(target)) return;
    const source = join(REPO, "node_modules");
    if (!existsSync(source)) return;
    // Fast path: hardlink tree (cp -al) when the worktree base shares a
    // filesystem with the repo. In dev containers /tmp and /workspaces are
    // different mounts (cross-device), so cp -al fails; fall back to a full
    // real copy. A symlinked node_modules is NOT an option: vitest browser
    // mode (Chromium) hangs on it. See memory worktree-node-modules-provisioning.
    if (exec("cp", ["-al", source, target]).status === 0) return;
    rmSync(target, { recursive: true, force: true });
    if (exec("cp", ["-a", source, target]).status !== 0) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(
        `node_modules provisioning failed for ${wt} - cp -al and cp -a both failed`,
      );
    }
  };

  // Config-driven worktree provisioning (config.worktree.provision): the
  // `npm-link` builtin (default, mirrors node_modules), `none` (no provisioning,
  // for a stack that needs none), or a script path (run with the worktree as its
  // one argument). Removes the npm assumption from worktree setup. Fail-closed on
  // a provision-script error, like the npm-link builtin.
  const provisionWorktree = (wt) => {
    let mode = "npm-link";
    try {
      mode = worktreeProvision(loadConfig());
    } catch {
      mode = "npm-link";
    }
    if (mode === "none") {
      log(`provision skipped (none) wt=${wt}`);
      return;
    }
    if (mode === "npm-link") {
      linkNodeModules(wt);
      return;
    }
    const script = isAbsolute(mode) ? mode : join(REPO, mode);
    const r = exec("bash", [script, wt], { cwd: REPO });
    if (r.status !== 0) {
      throw new Error(
        `worktree provision script failed (${script}): ${(r.stderr || r.stdout || "").slice(0, 300)}`,
      );
    }
    log(`provisioned via script ${script} wt=${wt}`);
  };

  return {
    name,
    repo: REPO,
    agentType,
    agentName,
    agentId,

    // Session-scoped, so each one refuses rather than resolving to a shared path.
    get sessionId() {
      return requireSessionId();
    },
    get sessionShort() {
      return requireSessionId().split("-")[0];
    },
    get sessionDir() {
      return sessionDirOf();
    },
    get worktreeBase() {
      return sessionDirOf();
    },
    get logFile() {
      return join(sessionDirOf(), "hooks.log");
    },
    get ticketsDir() {
      return process.env.TICKETS_DIR || join(sessionDirOf(), "tickets");
    },

    log,
    error,

    /**
     * Record an allow and END THE PROCESS. For a hook that owns its process (every
     * SubagentStop hook): the decision is final and nothing else in this process runs.
     * @param {string} [detail]
     * @returns {never}
     */
    accept(detail) {
      verdict("ACCEPT", detail);
      process.exit(0);
    },

    /**
     * Record an allow and RETURN. For a guard that runs inside a dispatcher chain
     * (lib/hook-chain.mjs): this guard is done, the next one still has to run, so
     * exiting here would silently skip every guard registered after it.
     * @param {string} [detail]
     * @returns {void}
     */
    allow(detail) {
      verdict("ACCEPT", detail);
    },

    /**
     * Record an allow for a decision this hook will reach on EVERY stop, and END THE
     * PROCESS. Logs the first occurrence of `key` in the session, then counts the rest in
     * `<sessionDir>/skips/<key>` instead of repeating the line.
     *
     * Every SubagentStop hook runs on every stop (the matcher is `.*`, because a role token
     * cannot match a plugin's namespaced agent_type), so "not my role" is now reached tens
     * of times per session by each of them. Measured on run eee7a672: 265 identical
     * `not orchestrator` lines and ~294 `skip: <role> stop` lines out of 1040 — the file
     * grew 27x and the lines that matter got harder to find, not easier.
     *
     * The observability rule still holds (rules/hook-authoring.md: absence of a line must
     * mean absence of a run). The FIRST line per key still proves the hook ran and says what
     * it saw, and the counter keeps the total recoverable for an audit. Same shape as the
     * `phantom-stops` and `identity-unresolvable` sentinels.
     * @param {string} key  Stable, filename-safe decision key, e.g. `not-orchestrator:developer`.
     * @param {string} [detail]
     * @returns {never}
     */
    acceptOnce(key, detail) {
      const safe = String(key).replace(/[^\w.-]+/g, "_");
      let seen = 0;
      let file = "";
      try {
        const dir = join(sessionDirOf(), "skips");
        mkdirSync(dir, { recursive: true });
        file = join(dir, safe);
        try {
          seen = parseInt(readFileSync(file, "utf8"), 10) || 0;
        } catch {
          seen = 0;
        }
        writeFileSync(file, `${seen + 1}\n`);
      } catch {
        seen = 0; // no session state to count in: fall back to logging every time
      }
      if (seen === 0) verdict("ACCEPT", detail);
      process.exit(0);
    },

    /**
     * @param {{ reason: string, log?: string }} options
     * @returns {never}
     */
    block({ reason, log: detail }) {
      verdict("BLOCK", detail);
      decisionBlock(reason);
      process.exit(0);
    },

    /**
     * @param {string} message
     * @param {{ log?: string }} [options]
     * @returns {never}
     */
    fail(message, { log: detail } = {}) {
      verdict("FAIL", detail);
      error(message);
      process.exit(2);
    },

    // Worktree provisioning: the config-driven dispatcher plus the npm-link
    // builtin it wraps (both defined as closures above).
    provisionWorktree,
    linkNodeModules,
  };
}
