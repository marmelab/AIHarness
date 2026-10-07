// Finding a session's agents on disk.
//
// Split out of run-ingest.mjs so the walk is unit-testable: the CLI around it runs at
// import time, and the one defect this file exists to prevent is invisible from outside.
//
// Claude Code writes a session's subagent transcripts to `subagents/`, as an
// `agent-<id>.jsonl` and `agent-<id>.meta.json` pair. A DYNAMIC WORKFLOW's agents use the
// same pair one directory deeper, under `subagents/workflows/<run id>/`, beside that run's
// `journal.jsonl`. A flat read of `subagents/` finds none of them, so a workflow run
// archives perfectly and then ingests as a session that cost money and spawned nobody.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

const readIf = (file) => {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return "";
  }
};

/**
 * Every agent transcript under a session directory, with its sidecar meta.
 *
 * An agent that came from a workflow run carries that run's id as `meta.workflowRun`, so
 * two runs in one session stay apart and each can be matched to its own journal.
 *
 * @param {string} dir a session directory, the one holding `subagents/`
 * @returns {{agentId: string, body: string, meta: object}[]}
 */
export function subagentsIn(dir) {
  const subs = join(dir, "subagents");
  if (!existsSync(subs)) return [];
  const out = [];

  const walk = (at, workflowRun) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        // The run id is the deepest directory: the `workflows` level above it is a
        // container and holds no agents of its own.
        walk(join(at, entry.name), at === subs ? null : entry.name);
        continue;
      }
      if (!entry.name.endsWith(".jsonl")) continue;
      // The journal is the runtime's own record, one result line per agent. Read as a
      // transcript it would invent an agent called `journal` in every workflow run.
      if (entry.name === "journal.jsonl") continue;

      const agentId = basename(entry.name, ".jsonl");
      let meta = {};
      const metaFile = join(at, `${agentId}.meta.json`);
      if (existsSync(metaFile)) {
        try {
          meta = JSON.parse(readFileSync(metaFile, "utf8"));
        } catch {
          /* an unreadable sidecar costs the agent its role label, not its numbers */
        }
      }
      out.push({
        agentId,
        body: readIf(join(at, entry.name)),
        meta: workflowRun ? { ...meta, workflowRun } : meta,
      });
    }
  };

  walk(subs, null);
  return out;
}
