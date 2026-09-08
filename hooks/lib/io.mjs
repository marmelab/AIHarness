// The stdout channels Claude Code reads back from a hook.
//
// Which channel a hook writes on decides who reads it, and the exit code is not the whole
// contract. Measured on Claude Code 2.1.263:
//
//   exit 0 + hookSpecificOutput.additionalContext  agent SEES it, call proceeds
//   exit 2 + stderr                                agent SEES it, call blocked
//   exit 1 + stderr                                agent does NOT see it
//   exit 0 + systemMessage                         agent does NOT see it
//
// So "warn the agent without blocking it" has exactly one spelling, and it is not the
// obvious one.

/**
 * Emit a PreToolUse "block" decision: denies the tool call and surfaces `reason`.
 * @param {string} reason
 */
export function decisionBlock(reason) {
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
}

/**
 * Replace a PreToolUse call's `tool_input` and let it proceed.
 *
 * Sent without `permissionDecision`, which is honoured (measured) and avoids waving the
 * call past the project's permission rules.
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
 * Emit `context` for the agent, leaving the tool call in place. Pair with exit 0: any
 * non-zero exit discards this channel.
 * @param {string} hookEventName
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
