// Run several PreToolUse guards in ONE node process instead of one process each.
//
// Claude Code spawns a process per registered hook, so a single Bash call paid for
// seven node startups and seven config loads before the command ran. The guards
// themselves are cheap; the spawning was the cost. A dispatcher registers once per
// matcher and calls each guard in the declared order.
//
// The contract a guard implements:
//
//   export function check(input, ctx) { ... }
//
// Returning means "not my business, run the next guard". Refusing is terminal and
// stays terminal, because ctx.block / ctx.fail (and a bare process.exit(2)) end the
// process: a denied tool call must not go on to have the later guards' side effects
// applied to it. Each guard still gets its OWN ctx, built with its own name, so the
// `[hook-name]` prefix in hooks.log is unchanged.
//
// A guard may also CORRECT the call with ctx.rewriteInput instead of refusing it. That is
// not terminal: the patch is collected here and one `updatedInput` is emitted after the
// last guard, so setup-worktree still runs. Each later guard sees the patched tool_input,
// because a chain where two guards disagree about what the call says is a bug waiting to
// happen.
//
// Every guard also stays runnable standalone (`node hooks/<guard>.mjs`), which is the
// shape all the hook tests use, so the behavior the tests pin is the behavior the
// dispatcher runs.

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { applyPatch, createHookContext } from "./context.mjs";
import { updatedToolInput } from "./io.mjs";

/**
 * The hook payload on stdin, or {} when it cannot be parsed.
 *
 * An unparseable payload is passed ON as {}, never turned into an early exit: a
 * PreToolUse guard runs for every caller, so each one must decide for itself whether
 * an unknown caller is refused (restrict-documentator-bash knows who it is from an
 * env var, so it still blocks) or waved through (every guard keyed on a command it
 * cannot read). Deciding centrally would flip one of those two the wrong way.
 * @returns {Record<string, unknown>}
 */
export function readPayload() {
  try {
    return JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return {};
  }
}

/**
 * Run `guards` in order against one payload, then exit 0 (allow).
 *
 * A guard that THROWS is reported on BOTH channels and the chain continues. Under
 * one-process-per-hook a crashing guard denied nothing and its siblings still ran;
 * that stays true here, and the error is reported rather than swallowed.
 * @param {Array<[string, (input: object, ctx: object) => void]>} guards
 * @param {object} [input]
 * @returns {never}
 */
export function runChain(guards, input = readPayload()) {
  let current = input;
  let rewritten = false;
  for (const [name, check] of guards) {
    const onRewrite = (patch) => {
      current = {
        ...current,
        tool_input: applyPatch(current.tool_input, patch),
      };
      rewritten = true;
    };
    const ctx = createHookContext(current, name, { onRewrite });
    try {
      check(current, ctx);
    } catch (e) {
      // Includes a guard reaching for session state in a context that has no session
      // id: that throws at the point of access, and this is where it becomes one
      // reported line instead of a dead chain. ctx.log falls back to stderr when there
      // is no session dir to write to, so the report survives having nowhere to go.
      const detail = String(e?.stack ?? e).slice(0, 300);
      ctx.log(`ERROR ${detail}`);
      // ...and unconditionally on stderr, the agent-visible channel, because hooks.log
      // ALONE made a crashed guard indistinguishable from a guard that had no opinion:
      // the chain exits 0, the tool call proceeds, and the only trace sits in a session
      // file nobody reads. Observed on bash-guard, where one missing import left every
      // rule it owns silently inert behind an exit 0 and an empty stderr.
      //
      // Deliberately still fail-OPEN. These guards share one process and run on every
      // matching tool call, so denying on an internal error would refuse calls the
      // crashed guard had no opinion about — including the ones needed to diagnose it —
      // and wedge the session until settings.json is edited. Loud beats closed here:
      // the hole stays visible for as long as it exists, and nothing is wedged.
      try {
        ctx.error(`guard crashed, its rules did NOT run: ${detail}`);
      } catch {
        // reporting must never break the chain
      }
    }
  }
  if (rewritten) updatedToolInput(current.tool_input);
  process.exit(0);
}

/**
 * Is `metaUrl` the module node was started with?
 * @param {string} metaUrl
 * @returns {boolean}
 */
export function isEntryPoint(metaUrl) {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const self = fileURLToPath(metaUrl);
  const entry = resolve(argv1);
  if (self === entry) return true;
  try {
    return realpathSync(self) === realpathSync(entry);
  } catch {
    return false;
  }
}

/**
 * Standalone entry point for a guard module: identical to being the only guard in a
 * chain. No-op when the module was imported by a dispatcher.
 * @param {string} metaUrl  import.meta.url of the guard module
 * @param {string} name     the guard's log prefix
 * @param {(input: object, ctx: object) => void} check
 * @returns {void}
 */
export function runStandalone(metaUrl, name, check) {
  if (!isEntryPoint(metaUrl)) return;
  runChain([[name, check]]);
}
