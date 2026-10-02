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
import {
  isFreeCommand,
  stripPrefixes,
} from "../../hooks/lib/bash-classify.mjs";

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
  const head = (s, n) => {
    const v = (typeof s === "string" ? s : "").replace(/\s+/g, " ").trim();
    return v.length > n ? v.slice(0, n) + "…" : v || null;
  };
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return tail(i.file_path);
    case "Bash":
      // From the START, and long. A command is named by its verb; the last ninety
      // characters of a pipeline are its plumbing. Paths keep their tail below, where the
      // basename is what identifies them.
      return head(i.command, 400);
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

// Verbs whose first non-flag word is the thing they do: `git log`, `npm run build`.
const SUBCOMMAND = new Set([
  "git",
  "docker",
  "npm",
  "pnpm",
  "yarn",
  "bun",
  "npx",
  "make",
  "gh",
  "supabase",
  "kubectl",
]);
// Verbs whose point is their pattern.
const PATTERN_FIRST = new Set(["grep", "rg", "egrep", "fgrep", "ag"]);
// Verbs that act on a file, named at the end rather than the start.
const FILE_LAST = new Set([
  "sed",
  "awk",
  "head",
  "tail",
  "cat",
  "wc",
  "sort",
  "uniq",
  "less",
]);
// Verbs that take their whole program as an argument, which is never a summary.
const INLINE = new Set([
  "node",
  "python",
  "python3",
  "deno",
  "ruby",
  "perl",
  "bun",
]);

/** Split a command line on its top-level separators, ignoring quoted ones. */
function topLevelSplit(command) {
  const out = [];
  let buf = "";
  let quote = "";
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = "";
      buf += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      buf += ch;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||") {
      out.push(buf);
      buf = "";
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "\n") {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  out.push(buf);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Words of one command, keeping a quoted run together. */
function words(stage) {
  return (stage.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((w) =>
    w.replace(/^['"]|['"]$/g, ""),
  );
}

const base = (p) => String(p).split("/").filter(Boolean).pop() || String(p);
const isFlag = (w) => w.startsWith("-");

/**
 * What a Bash command did, in a few words.
 *
 * The exact command is kept on the call and shown on hover; this is the label that makes a
 * table of two hundred rows readable. It has to start from the VERB: truncating a command
 * to its last ninety characters, which is right for a path, showed the tail of a pipeline
 * and never what was run — `…me_atomic-crm-demo --format '{{.State.StartedAt}}` names
 * nothing, where `docker ps` does.
 */
function bashSummary(command) {
  const text = String(command ?? "").trim();
  if (!text) return null;
  const stages = topLevelSplit(stripPrefixes(text));
  if (!stages.length) return null;
  const w = words(stages[0]);
  if (!w.length) return null;

  const verb = base(w[0]);
  const rest = w.slice(1);
  const firstArg = rest.find((x) => !isFlag(x));
  let what = "";

  if (INLINE.has(verb) && rest.some((x) => x === "-e" || x === "-c"))
    what = "inline script";
  else if (SUBCOMMAND.has(verb)) {
    // The run of plain words that opens the arguments, at most two. Two because one is
    // often only a noun: `gh pr edit` says something, `gh pr` does not. It stops at the
    // first flag, so an option's VALUE never leaks in — `docker ps -a --filter "name=x"`
    // is `docker ps`, not `docker ps name=x`. A leading short flag and its own value are
    // skipped first, so `git -C <path> log` still finds `log`.
    let i = 0;
    while (i < rest.length && isFlag(rest[i])) {
      const flag = rest[i];
      i++;
      if (/^-[A-Za-z]$/.test(flag) && i < rest.length && !isFlag(rest[i])) i++;
    }
    const run = [];
    while (i < rest.length && !isFlag(rest[i]) && run.length < 2) {
      const w = rest[i];
      i++;
      if (!/^\d+$/.test(w) && !w.includes("/")) run.push(w);
    }
    what = run.join(" ");
  } else if (PATTERN_FIRST.has(verb))
    what = firstArg ? '"' + firstArg + '"' : "";
  else if (FILE_LAST.has(verb)) {
    const file = [...rest].reverse().find((x) => !isFlag(x) && /[./]/.test(x));
    what = file ? base(file) : "";
  } else if (verb === "curl" || verb === "wget") {
    const url = rest.find((x) => /^https?:\/\//.test(x));
    what = url
      ? url
          .replace(/^https?:\/\//, "")
          .split("?")[0]
          .replace(/\/$/, "")
      : "";
  } else if (firstArg) what = /\//.test(firstArg) ? base(firstArg) : firstArg;

  let summary = (verb + " " + what).trim();
  if (summary.length > 44) summary = summary.slice(0, 43) + "…";
  // A long sequence is itself information: three commands chained is not one command.
  if (stages.length > 1) summary += " +" + (stages.length - 1);
  return summary;
}

/**
 * A few words saying what a call did, whatever the tool.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string|null}
 */
export function callSummary(toolName, input) {
  const name = String(toolName ?? "");
  if (!input || typeof input !== "object") return shortToolName(name);
  const i = /** @type {Record<string, unknown>} */ (input);
  if (name === "Bash" || name === "BashOutput")
    return bashSummary(i.command) || "bash";
  const path = typeof i.file_path === "string" ? base(i.file_path) : null;
  switch (name) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return path;
    case "Grep":
      return '"' + String(i.pattern ?? "").slice(0, 36) + '"';
    case "Glob":
      return typeof i.pattern === "string" ? i.pattern.slice(0, 40) : null;
    case "Skill":
      return typeof i.skill === "string" ? i.skill : null;
    case "Agent":
    case "Task":
      // The description, not the agent type: the table column already says Agent, and
      // "general-purpose" repeated forty times names nothing.
      return String(i.description || i.subagent_type || "agent").slice(0, 44);
    case "SendMessage":
      return "to " + String(i.to || "?");
    case "WebFetch":
      return String(i.url || "")
        .replace(/^https?:\/\//, "")
        .split("/")[0];
    case "WebSearch":
      return typeof i.query === "string" ? i.query.slice(0, 40) : null;
    default:
      // An MCP tool: its own short name already says what it does.
      return shortToolName(name);
  }
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
