#!/usr/bin/env node
// PreToolUse(Bash): single guard for Bash commands. Blocks commands that open browser windows (headed Playwright, Vite --open) for every caller, blocks the orchestrator from mutating the review/dispatch guard state under <sessionDir>/{reviews,breaker}, blocks gated subagents from running validation commands (validate-on-stop.mjs runs them automatically on SubagentStop), and blocks them from writing files through Bash instead of the Write/Edit tools.
// Every block names the rule that fired in its log line, and the file-write refusal names the allowed alternative for the cause that fired: an editing agent is sent to the Write tool, an agent capturing a process's output is given the sinks it may use.

import { readFileSync } from "node:fs";
import { createHookContext } from "./lib/context.mjs";
import {
  isDeveloper,
  isOrchestrator,
  isQualityReviewer,
} from "./lib/teams.mjs";
import {
  loadConfig,
  validationSteps,
  extraForbidden,
  launcher,
} from "./lib/config.mjs";
import { isScratchpadTarget, scratchpadDir } from "./lib/scratchpad.mjs";

const input = JSON.parse(readFileSync(0, "utf8"));
const ctx = createHookContext(input, "bash-guard");

const agent = input.agent_type || "";
const cmd = input.tool_input?.command || "";

if (!cmd) process.exit(0);

// Browser rules — any caller: this sandbox has no display, a headed run hangs forever.
const opensHeadedPlaywright = (c) =>
  /playwright/.test(c) &&
  (/(--headed|--ui\b|--debug\b)/.test(c) ||
    /playwright\s+(open|codegen)\b/.test(c));
const opensViteBrowser = (c) =>
  /(vite|npm run (dev|start|start-demo))/.test(c) && c.includes("--open");

// Every rule carries the label the log line reports, so a block is judgeable
// after the fact from hooks.log alone: the agent-facing message already names
// the rule, and a log that only says "browser" or "file-write" cannot say which
// of five phrasings the agent was refused for.
const BROWSER_RULES = [
  [
    "headed-playwright",
    opensHeadedPlaywright,
    "Playwright must stay headless (this sandbox has no display): drop --headed / --ui / --debug, and don't run `playwright open` / `codegen`. Headless is the default, no flag needed.",
  ],
  [
    "vite-open",
    opensViteBrowser,
    "Vite must not use --open (opens a browser window). Remove the --open flag.",
  ],
];

const browserViolation = BROWSER_RULES.find(([, matches]) => matches(cmd));
if (browserViolation) {
  ctx.block({
    reason: browserViolation[2],
    log: `browser rule=${browserViolation[0]} cmd=${cmd.slice(0, 120)}`,
  });
}

// Guard-state rule — orchestrator only: the orchestrator must NEVER mutate the
// hook state under <sessionDir>/reviews (review-verdict flags) or
// <sessionDir>/breaker (planner/duplicate-dispatch markers). Those files ARE the
// safety guards (block-merger-without-review, block-duplicate-dispatch) — an
// orchestrator that touches/rm's them forges an approval or clears a debounce and
// bypasses review entirely.
// Match the orchestrator the same way block-nested-orchestrator does: agent_type
// when present, else the CLAUDE_AGENT_NAME-derived ctx.agentType, allowing a
// suffixed runtime name (orchestrator-…) and the chat- prefix. (isOrchestrator
// lives in lib/teams.mjs so both gates share one predicate.)
if (isOrchestrator(agent || ctx.agentType)) {
  // Match `reviews`/`breaker` as a path segment bounded on the left by `/` and
  // on the right by `/`, a quote, whitespace, or end-of-token. The trailing-slash
  // form alone missed the command the codebase actually teaches the reviewer to
  // use — `RD="$(dirname "$TICKET_FILE")/reviews" && touch "$RD/<flag>"` — whose
  // literal text is `…/reviews"` then `$RD/…`, never `/reviews/`. That let a
  // confused orchestrator forge a verdict flag through the documented form.
  const guardPath = /\/(reviews|breaker|validation-gave-up)(\/|["'\s]|$)/;
  const mutatingVerb =
    /(^|[;&|]|\bsudo\b|\bxargs\b)\s*(rm|touch|mkdir|mv|cp|truncate|ln)\b/.test(
      cmd,
    ) ||
    /\bsed\s+(-[a-zA-Z]*i\b|--in-place)/.test(cmd) ||
    /\|\s*tee\b/.test(cmd);
  const redirectToGuard =
    />>?\s*\S*\/(reviews|breaker|validation-gave-up)(\/|["'\s]|$)/.test(cmd);
  if ((mutatingVerb && guardPath.test(cmd)) || redirectToGuard) {
    ctx.block({
      reason:
        "Refusing this command: the orchestrator must not write to or delete files under <session_dir>/reviews or <session_dir>/breaker — those ARE the review/dispatch guards. " +
        "If a merger dispatch was blocked for 'no APPROVED verdict', do NOT fabricate the flag and do NOT re-dispatch the reviewer: the reviewer writes its own flag on APPROVED (quality-reviewer.md). A missing flag means the reviewer did NOT approve — read its output file and act on the real verdict. " +
        "If a dispatch was blocked as 'still in flight', wait for its task-notification instead of clearing the marker.",
      log: `orchestrator rule=guard-state-mutation cmd=${cmd.slice(0, 120)}`,
    });
  }
}

const runsTypecheck = (c) =>
  /(make\s+typecheck|npm\s+run\s+typecheck|npx\s+tsc(\s|$)|tsc\s+--noEmit)/.test(
    c,
  );
const runsPrettier = (c) =>
  /(npm\s+run\s+prettier(:apply)?|npx\s+prettier(\s|$)|make\s+prettier)/.test(
    c,
  );
const runsUnitTests = (c) =>
  /(npm\s+run\s+test(:unit)?(:[a-z]+)?|npm\s+test\b|npx\s+vitest|make\s+test(-unit)?(-[a-z]+)?)/.test(
    c,
  );
// Any make target whose name carries `e2e`, not just the ones that RUN the suite: the
// targets that bring the stack UP are worse than the suite itself. Observed in the wild
// on `make start-e2e`, which (1) never returns, because it backgrounds a dev server that
// keeps the pipe open, (2) `rm -rf`s the e2e database, destroying a human's session, and
// (3) starts the SHARED stack the harness deliberately replaces with a slot-leased
// isolated one. Matching the token rather than enumerating targets keeps this from
// growing a per-project list.
const runsE2eTests = (c) =>
  /(npx\s+playwright\s+test|make\s+[\w:-]*e2e|e2e-smoke\.sh)/.test(c);
const runsLint = (c) => /(make\s+lint\b|npm\s+run\s+lint\b)/.test(c);
const runsBuild = (c) =>
  /(npx\s+vite\s+build|npm\s+run\s+build\b|make\s+build\b)/.test(c);

const CATEGORY_RULES = {
  typecheck: [
    runsTypecheck,
    "typecheck: validate-on-stop.mjs runs this automatically after you stop; read its stderr output instead.",
  ],
  prettier: [
    runsPrettier,
    "prettier: the validation hooks auto-apply prettier and commit the result; don't run it manually.",
  ],
  unit: [
    runsUnitTests,
    "unit tests: the validation hooks run vitest automatically. In this sandbox vitest browser mode HANGS without CI=true (chromium headed waits for display). Trust the hooks.",
  ],
  e2e: [
    runsE2eTests,
    "e2e tests: NO agent launches the suite, not even the orchestrator. The e2e-on-feature-review hook runs it once, on the integrated session worktree, only after the feature review APPROVED, and writes <session_dir>/e2e-result.json. Write the spec, read the result, don't run it. If a human asked you directly: say it is not yours to run, and offer the two real options, they run it themselves with a user-typed `!` command (those bypass this guard by design), or the change goes through #harness and the end-of-feature hook runs it. Do NOT offer to bypass this guard or ask to be authorized to: a deny blocks the call whatever anyone answers, so the offer is impossible as well as wrong.",
  ],
  lint: [
    runsLint,
    "lint: validate-on-stop.mjs runs eslint on your changed files automatically after you stop; read its stderr output instead.",
  ],
  build: [
    runsBuild,
    "build: don't run production builds during tickets; typecheck (run by the validation hooks) catches type errors.",
  ],
};

// Which categories to guard comes from the SAME config the validation chain runs
// (kills the triple-encoding: runner, guard, and doc no longer drift). Each
// validation step's kind maps to a category (lint included — it is now a chain
// step), plus validation.extraForbidden (build, e2e — never run during tickets,
// not part of the chain). Fail-open to ALL categories if the config can't be read,
// so a malformed config never weakens the guard.
const KIND_TO_CATEGORY = {
  format: "prettier",
  typecheck: "typecheck",
  lint: "lint",
  unit: "unit",
  e2e: "e2e",
};
let activeCategories;
try {
  const cfg = loadConfig();
  activeCategories = new Set([
    ...validationSteps(cfg)
      .map((s) => KIND_TO_CATEGORY[s.kind])
      .filter(Boolean),
    ...extraForbidden(cfg),
  ]);
} catch {
  activeCategories = new Set(Object.keys(CATEGORY_RULES));
}

// e2e is the one category gated for EVERY caller, not just the two agents below:
// launching the suite is a hook's job (e2e-on-feature-review.mjs), so an orchestrator
// or a main-session Bash call must be refused too. Still config-driven — drop "e2e"
// from validation.extraForbidden and this stops applying, like any other category.
if (activeCategories.has("e2e") && runsE2eTests(cmd)) {
  ctx.block({
    reason: `Validation command forbidden: ${CATEGORY_RULES.e2e[1]} See the harness rule validation-commands.md, including what to answer when a human asks you directly.`,
    log: `any-caller rule=e2e cmd=${cmd.slice(0, 120)}`,
  });
}

// Validation rules — gated subagents only: the validation hooks already run
// these; manual runs burn budget and can hang (vitest headed without CI=true).
// Resolve identity the same robust way as the guard-state rule above: prefer the
// payload agent_type, fall back to the CLAUDE_AGENT_NAME-derived ctx.agentType,
// and match via the suffix-aware predicates — so a `developer-TASK-001` runtime
// name (or an empty agent_type) is still gated, not silently waved through.
const who = agent || ctx.agentType || "";
if (!isDeveloper(who) && !isQualityReviewer(who)) process.exit(0);

const VALIDATION_RULES = [...activeCategories]
  .filter((c) => CATEGORY_RULES[c])
  .map((c) => [c, ...CATEGORY_RULES[c]]);

const violation = VALIDATION_RULES.find(([, matches]) => matches(cmd));
if (violation) {
  ctx.block({
    reason: `Validation command forbidden: ${violation[2]} See the harness rule validation-commands.md, including what to answer when a human asks you directly.`,
    log: `rule=${violation[0]} cmd=${cmd.slice(0, 120)}`,
  });
}

// File-write rules — gated subagents only: code-writing agents must use the
// Write/Edit tools, never Bash redirection/in-place edits. Bash writes bypass the
// Write|Edit-only block-migration-writes guard (a developer could otherwise write a migration in
// bash).
//
// `>` is two different acts wearing one syntax: producing a FILE (an edit the
// Write tool must own) and capturing a running process's OUTPUT (a reviewer
// reading a dev server's log). They are refused with different messages, because
// a refusal that names no allowed exit is a wall an agent can only probe.
// The managed-launcher log dir (e.g. CRM Builder's /chat-service/logs) is a
// launcher extension point: config.launcher.logsDir. A redirect into it is
// exempt (agents legitimately append their logs there). When unset, only
// /dev/null is exempt and no chat-service path is hardcoded.
let logsDir = "";
try {
  logsDir = launcher(loadConfig()).logsDir || "";
} catch {
  logsDir = "";
}

// `>` / `>>` and the token it writes to. The character before `>` may be neither
// a digit nor `&` (fd duplication, `2>&1`) nor `=`. `=>` is a JavaScript arrow,
// and reading it as a redirect refuses every `node -e` one-liner that passes a
// callback, which is how an agent drives a headless browser from Bash.
const REDIRECT_RE = /(^|[^0-9&=])>>?\s*("[^"]*"|'[^']*'|[^\s;|&)<>]+)/g;
// A target counts only when it names a path or a suffixed file, so an
// unresolvable `> $LOG` stays out (matching what the guard has always caught).
const looksLikeFile = (t) =>
  /^(\/|\.\.?\/|~\/)/.test(t) ||
  /^[a-zA-Z0-9._-]+\//.test(t) ||
  /^[a-zA-Z0-9._-]+\.[a-zA-Z0-9]+/.test(t);
const unquote = (t) => t.replace(/^["']|["']$/g, "");

// tee writes to its file argument(s); skip leading flags (e.g. -a) to reach the
// target. Bare `| tee` (no file) only duplicates to stdout, not a write.
const teeTarget = (c) => {
  const m = c.match(/\|\s*tee\s+((?:-\S+\s+)*)(\S+)/);
  return m ? unquote(m[2]) : "";
};
const writesSedInPlace = (c) => /sed\s+(-[a-zA-Z]*i\b|--in-place)/.test(c);
const writesAwkInPlace = (c) => /awk\s+-i\s+inplace/.test(c);
const writesScript = (c) =>
  /(node|python3?)\s+-[ecp].*(writeFileSync|writeFile|write_text|os\.write|fs\.write)/.test(
    c,
  );

// The reviewer roles are the ones that RUN the app to verify it, so they own the
// session scratchpad as a log sink. bareRole handles the namespaced
// (aiharness:quality-reviewer) and suffixed runtime names.
const isReviewer = isQualityReviewer(who);
const exemptTarget = (t) =>
  t === "/dev/null" ||
  (logsDir && t.startsWith(`${logsDir}/`)) ||
  (isReviewer && isScratchpadTarget(t, ctx.sessionId));

// Evaluate the exemptions PER target, so an unrelated `cmd 2>/dev/null` cannot
// disarm detection of a real `> file` write in the same command.
const redirectViolations = [];
for (const m of cmd.matchAll(REDIRECT_RE)) {
  const target = unquote(m[2]);
  if (!looksLikeFile(target) || exemptTarget(target)) continue;
  redirectViolations.push(["redirect", target]);
}
const tee = teeTarget(cmd);

const writeViolation = [
  ...redirectViolations,
  ...(writesSedInPlace(cmd) ? [["sed-in-place", ""]] : []),
  ...(writesAwkInPlace(cmd) ? [["awk-in-place", ""]] : []),
  ...(tee && !exemptTarget(tee) ? [["tee", tee]] : []),
  ...(writesScript(cmd) ? [["scripted-write", ""]] : []),
][0];

if (writeViolation) {
  const [rule, target] = writeViolation;
  // A log-shaped or extensionless target is a process writing down what it
  // printed; any other suffix is an artefact the editing tools must produce.
  const base = target.split("/").pop() || "";
  const capturesOutput =
    (rule === "redirect" || rule === "tee") &&
    (/\.(log|out|err)$/i.test(base) || !/\.[A-Za-z0-9]+$/.test(base));

  const scratchpadSink = isReviewer
    ? `redirect it into this session's scratchpad directory (\`${scratchpadDir(ctx.sessionId) || `.../${ctx.sessionId}/scratchpad`}\`)`
    : "redirecting into the session scratchpad directory is allowed for the quality-reviewer only";
  const logsSink = logsDir ? `; redirect it under \`${logsDir}/\`` : "";

  ctx.block({
    reason: capturesOutput
      ? `Capturing process output to a file via Bash is gated (${rule} -> ${target}), because the same syntax writes source files. Allowed forms, in order of preference: (1) drop the redirect entirely and read the stdout/stderr the Bash tool already returns to you; (2) start a long-running process (a dev server) with \`run_in_background: true\` instead of \`nohup\` / \`&\`, then read its output back through the background-task output, no file needed; (3) discard it with \`> /dev/null 2>&1\`; (4) ${scratchpadSink}${logsSink}. See quality-reviewer.md, "Running the app for runtime verification".`
      : `File editing via Bash is forbidden: ${rule}${target ? ` -> ${target}` : ""}. Use the Write or Edit tool instead: a Bash write bypasses prettier/typecheck and the migration-write guard. See developer.md.`,
    log: `file-write rule=${rule} kind=${capturesOutput ? "process-output" : "file-edit"} cmd=${cmd.slice(0, 120)}`,
  });
}

process.exit(0);
