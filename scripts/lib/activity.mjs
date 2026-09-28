// What an agent was DOING, per tool call.
//
// The run report's central question is not "how many tokens" but "where did the developer
// spend its 20 minutes". That needs every tool call bucketed into an activity, and the
// buckets have to mean the same thing across roles or the columns do not compare.
//
// The rule table lives in scripts/config/activities.json, not here, because the taxonomy
// is the thing that will keep changing: a new MCP server, a new validation runner, a new
// bookkeeping file. Adding a bucket must stay a one-line edit in a data file.
//
// Bash is the hard case, and it is the one place this module does not invent anything: it
// defers to hooks/lib/bash-classify.mjs, which already knows that `cd /wt && FOO=1 grep x`
// is exploration and `grep x | node build.mjs` is not, and which is covered by its own
// tests. Re-deriving that here would produce a second, worse answer to the same question.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isFreeCommand } from "../../hooks/lib/bash-classify.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const RULES_FILE = join(HERE, "..", "config", "activities.json");

/** Activities that describe time nobody spent calling a tool. */
export const SYNTHETIC = Object.freeze({
  /** A turn that called no tool at all: deliberation, paid at full context price. */
  THINK: "think",
  /**
   * The gap between one turn's last result and the next turn, up to the idle cap: the
   * post-tool hooks plus the next turn's generation, which the transcript cannot separate.
   */
  WAIT: "wait",
  /** The part of a gap beyond the idle cap: a human at a gate, or a session left open. */
  IDLE: "idle",
});

/**
 * Load the rule table.
 * @param {string} [file]
 * @returns {object}
 */
export function loadRules(file = RULES_FILE) {
  return JSON.parse(readFileSync(file, "utf8"));
}

/**
 * The validation commands a project declares, as plain tokens to match in a Bash call.
 *
 * A generic regex catches `npm test` and `tsc`, and misses `make verify` or a bespoke
 * runner script. The project already names its chain in harness.config.json, so read it
 * rather than guess: this is the same rule the hooks follow.
 *
 * @param {object|null} harnessConfig  a parsed harness.config.json, or null
 * @returns {string[]} command heads, longest first so the specific one matches first
 */
export function validateCommandsFrom(harnessConfig) {
  const steps = harnessConfig?.validation?.steps;
  if (!Array.isArray(steps)) return [];
  const out = new Set();
  for (const step of steps) {
    const cmd = typeof step?.command === "string" ? step.command.trim() : "";
    if (cmd) out.add(cmd);
    // `runner: "vitest"` steps carry no command; the runner name is what shows up.
    if (typeof step?.runner === "string" && step.runner.trim())
      out.add(step.runner.trim());
  }
  return [...out].sort((a, b) => b.length - a.length);
}

const escape = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build a classifier bound to one rule table and one project.
 *
 * @param {object} [opts]
 * @param {object} [opts.rules] parsed rule table (defaults to the shipped one)
 * @param {string[]} [opts.validateCommands] project validation commands, matched first
 * @returns {(toolName: string, input: unknown) => string}
 */
export function makeClassifier({
  rules = loadRules(),
  validateCommands = [],
} = {}) {
  const byTool = rules.byTool || {};
  const byPrefix = (rules.byToolPrefix || []).map((r) => ({
    prefix: String(r.prefix || ""),
    activity: r.activity,
  }));
  const bashRules = (rules.bash || []).map((r) => ({
    activity: r.activity,
    free: r.free === true,
    re: r.match ? new RegExp(r.match) : null,
  }));
  const fallback = rules.fallback || "other";
  // Built once: a project with a long chain would otherwise recompile these per call.
  const validateRes = validateCommands
    .filter(Boolean)
    .map((c) => new RegExp(`(^|[\\s;&|(])${escape(c)}([\\s;&|)]|$)`));

  const classifyBash = (command) => {
    const text = String(command ?? "");
    if (!text.trim()) return fallback;
    for (const re of validateRes) if (re.test(text)) return "validate";
    for (const rule of bashRules) {
      if (rule.re) {
        if (rule.re.test(text)) return rule.activity;
        continue;
      }
      if (rule.free) {
        if (isFreeCommand(text)) return rule.activity;
        continue;
      }
      return rule.activity; // a rule with neither match nor free is the bash default
    }
    return fallback;
  };

  return function classify(toolName, input) {
    const name = String(toolName ?? "");
    if (!name) return fallback;
    if (name === "Bash" || name === "BashOutput")
      return classifyBash(
        input && typeof input === "object" ? input.command : "",
      );
    if (Object.prototype.hasOwnProperty.call(byTool, name)) return byTool[name];
    for (const { prefix, activity } of byPrefix)
      if (prefix && name.startsWith(prefix)) return activity;
    return fallback;
  };
}

/**
 * A short, human-readable "what did this call do", for the report's drill-down.
 *
 * Deliberately lossy and deliberately stable: it is a label in a timeline, not a record.
 * Ported from crm-builder's chat-service/lib/stats/tools.js, which had the same job.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string|null}
 */
export function callDetail(toolName, input) {
  if (!input || typeof input !== "object") return null;
  const i = /** @type {Record<string, unknown>} */ (input);
  const tail = (s, n = 90) => {
    const v = typeof s === "string" ? s : "";
    return v.length > n ? "…" + v.slice(-n) : v || null;
  };
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return tail(i.file_path);
    case "Bash":
      return tail(i.command, 90);
    case "Grep":
      return `"${i.pattern ?? ""}"${i.path ? ` in ${i.path}` : ""}`;
    case "Glob":
      return typeof i.pattern === "string" ? i.pattern : null;
    case "Skill":
      return typeof i.skill === "string" ? i.skill : null;
    case "Agent":
    case "Task":
      return `${i.subagent_type || "?"}: ${String(i.description || "").slice(0, 70)}`;
    case "SendMessage":
      return `→ ${i.to || "?"}`;
    case "WebFetch":
      return tail(i.url);
    case "WebSearch":
      return typeof i.query === "string" ? i.query.slice(0, 70) : null;
    default:
      // An MCP tool, most likely. Its input keys are the server's, not ours, so pick the
      // ones that name a target and let anything else fall through to the key list.
      // Without this the reviewer's 143 browser minutes are 119 rows of "null": the
      // aggregate says where the time went and nothing says what it was spent on.
      return mcpDetail(i);
  }
}

// The keys an MCP tool uses to say what it acted on, in the order a reader wants them.
const MCP_TARGET_KEYS = [
  "element",
  "url",
  "selector",
  "ref",
  "text",
  "key",
  "query",
  "name",
  "path",
  "command",
];

function mcpDetail(input) {
  const parts = [];
  for (const key of MCP_TARGET_KEYS) {
    const v = input[key];
    if (typeof v === "string" && v.trim()) parts.push(v.trim().slice(0, 60));
    if (parts.length === 2) break;
  }
  if (parts.length) return parts.join(" · ");
  const keys = Object.keys(input).filter((k) => input[k] != null);
  return keys.length ? keys.slice(0, 4).join(",") : null;
}

/**
 * The tool's name without its MCP packaging.
 *
 * `mcp__plugin_playwright_playwright__browser_click` is `browser_click`: a timeline column
 * 45 characters wide shows the server three times and the action never.
 *
 * @param {string} toolName
 * @returns {string}
 */
export function shortToolName(toolName) {
  const name = String(toolName ?? "");
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  return parts[parts.length - 1] || name;
}

/**
 * The stable identity of a call, for repeat detection.
 *
 * Two calls are "the same" when the tool and the input that decides the result are the
 * same. A Read of the same file with a different offset is not a repeat; a Grep with the
 * same pattern in the same path is.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string}
 */
export function callSignature(toolName, input) {
  const name = String(toolName ?? "");
  if (!input || typeof input !== "object") return name;
  const i = /** @type {Record<string, unknown>} */ (input);
  const parts = [name];
  const push = (v) =>
    parts.push(typeof v === "string" ? v : JSON.stringify(v ?? null));
  switch (name) {
    case "Read":
      push(i.file_path);
      push(i.offset ?? "");
      push(i.limit ?? "");
      break;
    case "Bash":
      push(String(i.command ?? "").trim());
      break;
    case "Grep":
      push(i.pattern);
      push(i.path ?? "");
      push(i.glob ?? "");
      break;
    case "Glob":
      push(i.pattern);
      push(i.path ?? "");
      break;
    case "Edit":
      push(i.file_path);
      push(i.old_string ?? "");
      break;
    case "Write":
      push(i.file_path);
      break;
    case "Skill":
      push(i.skill);
      push(i.args ?? "");
      break;
    case "Agent":
    case "Task":
      push(i.subagent_type ?? "");
      push(i.description ?? "");
      break;
    default: {
      // Unknown tools: the whole input, sorted so key order cannot invent a difference.
      const keys = Object.keys(i).sort();
      for (const k of keys) push(`${k}=${JSON.stringify(i[k] ?? null)}`);
    }
  }
  return parts.join("\u0000");
}

/**
 * The file a call touched, when it touched exactly one. Lets a SQL query answer "which
 * rules did this agent read" or "which file was rewritten four times" without the
 * ingester needing to know those questions in advance.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string|null}
 */
export function callPath(toolName, input) {
  if (!input || typeof input !== "object") return null;
  const p = /** @type {Record<string, unknown>} */ (input).file_path;
  return typeof p === "string" && p ? p : null;
}
