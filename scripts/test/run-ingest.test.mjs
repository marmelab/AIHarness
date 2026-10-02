// Tests for finding a session's agents on disk.
//
// A dynamic workflow's agents are written one directory deeper than every other subagent,
// under `subagents/workflows/<run id>/`. The flat read that preceded this found none of
// them: a workflow run archived perfectly and ingested as a session with no agents, so a
// report over it showed a session that cost money and spawned nobody.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { subagentsIn } from "../lib/transcripts.mjs";

let TMP = null;

afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

/** A session directory holding a plain subagent and a workflow run's three agents. */
const session = ({ journal = true } = {}) => {
  TMP = mkdtempSync(join(tmpdir(), "run-ingest-"));
  const subs = join(TMP, "subagents");
  const wf = join(subs, "workflows", "wf_1322b3b4-cad");
  mkdirSync(wf, { recursive: true });

  writeFileSync(join(subs, "agent-plain.jsonl"), '{"type":"assistant"}\n');
  writeFileSync(
    join(subs, "agent-plain.meta.json"),
    JSON.stringify({ agentType: "aiharness:developer" }),
  );

  for (const id of ["agent-a2a", "agent-a5e"]) {
    writeFileSync(join(wf, `${id}.jsonl`), '{"type":"assistant"}\n');
    writeFileSync(
      join(wf, `${id}.meta.json`),
      JSON.stringify({
        agentType: "workflow-subagent",
        workflowPhase: "Tool gate",
      }),
    );
  }
  // One agent whose sidecar never landed: it still has a transcript and still counts.
  writeFileSync(join(wf, "agent-ac9.jsonl"), '{"type":"assistant"}\n');
  if (journal)
    writeFileSync(join(wf, "journal.jsonl"), '{"type":"result","index":0}\n');
  return TMP;
};

describe("subagentsIn", () => {
  test("finds a workflow's agents, not just the ones beside the transcript", () => {
    const found = subagentsIn(session());
    expect(found.map((a) => a.agentId).sort()).toEqual([
      "agent-a2a",
      "agent-a5e",
      "agent-ac9",
      "agent-plain",
    ]);
  });

  test("keeps each agent's own meta, and names the run a workflow agent came from", () => {
    // Without the run id the agents of two workflow runs in one session are one
    // undifferentiated pile, and `journal.jsonl` beside them can no longer be matched up.
    const found = subagentsIn(session());
    const byId = Object.fromEntries(found.map((a) => [a.agentId, a]));
    expect(byId["agent-plain"].meta).toEqual({
      agentType: "aiharness:developer",
    });
    expect(byId["agent-plain"].meta.workflowRun).toBeUndefined();
    expect(byId["agent-a2a"].meta).toEqual({
      agentType: "workflow-subagent",
      workflowPhase: "Tool gate",
      workflowRun: "wf_1322b3b4-cad",
    });
  });

  test("a missing sidecar costs the agent its labels, not its transcript", () => {
    const found = subagentsIn(session());
    const orphan = found.find((a) => a.agentId === "agent-ac9");
    expect(orphan.body).toContain("assistant");
    expect(orphan.meta).toEqual({ workflowRun: "wf_1322b3b4-cad" });
  });

  test("the workflow's own journal is not mistaken for an agent", () => {
    // It is one result line per agent, the runtime's record, and reading it as a
    // transcript would invent an agent called `journal` in every workflow run.
    const found = subagentsIn(session({ journal: true }));
    expect(found.map((a) => a.agentId)).not.toContain("journal");
  });

  test("a session with no subagents directory yields nothing", () => {
    TMP = mkdtempSync(join(tmpdir(), "run-ingest-"));
    expect(subagentsIn(TMP)).toEqual([]);
  });
});
