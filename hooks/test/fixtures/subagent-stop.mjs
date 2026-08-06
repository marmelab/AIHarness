// The SubagentStop payload and transcript layout AS MEASURED against Claude Code
// v2.1.223, in one place, because the suite's inability to see the identity bug came
// down to every fixture inventing a friendlier shape than the runtime's.
//
// What the runtime actually does:
//   - `agent_type` in the payload is EMPTY (so hooks.json matchers do not filter).
//   - `transcript_path` names the MAIN SESSION transcript, not the stopping agent's.
//   - `agent_id` names the stopping agent, and its spawn meta plus its own transcript
//     live one directory down:
//
//       <projects>/<slug>/<session-id>.jsonl                        main transcript
//       <projects>/<slug>/<session-id>/subagents/agent-<id>.jsonl    the agent's own
//       <projects>/<slug>/<session-id>/subagents/agent-<id>.meta.json
//
//   - meta.agentType arrives BARE or NAMESPACED (`aiharness:orchestrator`), both
//     observed in real meta files.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Build the runtime's transcript layout for a session under `root`.
 * @param {string} root  A throwaway directory.
 * @param {string} sessionId
 */
export function runtimeLayout(root, sessionId) {
  const projectDir = join(root, "projects", "-workspaces-app");
  const subagents = join(projectDir, sessionId, "subagents");
  mkdirSync(subagents, { recursive: true });
  const mainTranscript = join(projectDir, `${sessionId}.jsonl`);
  writeFileSync(mainTranscript, "");
  return { projectDir, mainTranscript, subagents, sessionId };
}

/**
 * Write one subagent's spawn meta and transcript, the way the runtime does.
 * @param {{subagents: string}} layout
 * @param {string} agentId
 * @param {{agentType: string, description?: string}} meta
 * @param {string} [dispatchPrompt]  The first user event, i.e. the dispatch contract.
 * @param {string[]} [assistantTexts]  Assistant turns, in order.
 */
export function spawnAgent(
  layout,
  agentId,
  meta,
  dispatchPrompt = "",
  assistantTexts = [],
) {
  writeFileSync(
    join(layout.subagents, `agent-${agentId}.meta.json`),
    JSON.stringify({
      agentType: meta.agentType,
      description: meta.description || "",
      toolUseId: `toolu_${agentId}`,
      parentAgentId: "aparent00000000000",
      spawnDepth: 2,
    }),
  );
  const events = [];
  if (dispatchPrompt)
    events.push({
      type: "user",
      message: { role: "user", content: dispatchPrompt },
    });
  for (const text of assistantTexts)
    events.push({
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  const transcript = join(layout.subagents, `agent-${agentId}.jsonl`);
  writeFileSync(
    transcript,
    events.map((e) => JSON.stringify(e)).join("\n") +
      (events.length ? "\n" : ""),
  );
  return transcript;
}

/**
 * A SubagentStop payload as the runtime sends it: empty agent_type, the MAIN
 * transcript, and the stopping agent's id.
 * @param {{mainTranscript: string, sessionId: string}} layout
 * @param {string} [agentId]  Omit to model a payload with no agent id at all.
 */
export function stopPayload(layout, agentId, extra = {}) {
  return {
    session_id: layout.sessionId,
    hook_event_name: "SubagentStop",
    agent_type: "",
    transcript_path: layout.mainTranscript,
    ...(agentId ? { agent_id: agentId } : {}),
    ...extra,
  };
}
