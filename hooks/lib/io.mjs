// The stdout channels Claude Code reads back from a hook.
//
// Which channel a hook writes on decides WHO reads it, and the runtime is not symmetric
// about this. Measured on Claude Code 2.1.263 (2026-09-07) by running a probe hook in each
// mode and asking the agent to quote back anything it received:
//
//   exit 0 + hookSpecificOutput.additionalContext  -> attachment `hook_additional_context`,
//                                                     the agent SEES it, the tool call stands
//   exit 2 + stderr                                -> attachment `hook_blocking_error`,
//                                                     the agent SEES it, the call is blocked
//   exit 1 + stderr                                -> attachment `hook_non_blocking_error`,
//                                                     the agent does NOT see it
//   exit 0 + systemMessage                         -> attachment `hook_system_message`,
//                                                     the agent does NOT see it
//
// So "warn the agent without blocking it" has exactly ONE spelling: exit 0 with
// additionalContext. Exiting 1 with a message on stderr is the shape that reads like a
// warning and delivers nothing: three of this harness's PostToolUse checks did that, and
// their text appears in none of the developer transcripts that should have received it.

/**
 * Emit a PreToolUse "block" decision: denies the tool call and surfaces `reason`.
 * @param {string} reason
 */
export function decisionBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

/**
 * Emit a rewritten `tool_input` for a PreToolUse call, letting it proceed with the new
 * value. Measured on 2.1.263: the agent asked to Read `data.txt` and received the contents
 * of the file this channel substituted, so a guard can CORRECT a dispatch instead of
 * refusing it and spending a turn on the retry.
 *
 * `permissionDecision` is deliberately NOT sent with it. Measured: `updatedInput` alone is
 * honoured, and adding `permissionDecision: "allow"` would also wave the call past whatever
 * the project's permission rules would have asked, which is not this channel's job.
 * @param {Record<string, unknown>} toolInput  The COMPLETE replacement tool_input.
 */
export function updatedToolInput(toolInput) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: toolInput,
      },
    }) + "\n",
  );
}

/**
 * Emit `context` as additional context for the agent, leaving the tool call in place.
 * Pair with exit 0: any non-zero exit discards this channel.
 * @param {string} hookEventName  The event from the payload, echoed back as the runtime expects.
 * @param {string} context
 */
export function additionalContext(hookEventName, context) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: hookEventName || "PostToolUse",
        additionalContext: context,
      },
    }) + "\n",
  );
}
