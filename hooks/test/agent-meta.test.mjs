// Tests for lib/agent-meta.mjs: resolving WHO stopped, from a SubagentStop payload.
//
// The property to hold: identity resolves on the payload the RUNTIME sends, where
// transcript_path names the MAIN SESSION transcript rather than the stopping agent's. A
// sibling `<transcript>.meta.json` derived from that path never exists, so every guard
// keying on it would be a no-op. The fixtures therefore build the layout the runtime
// actually writes (see fixtures/subagent-stop.mjs), not a friendlier one.

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, test, vi } from "vitest";
import { REPO, TMP_ROOT, sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const TMP = mkdtempSync(join(tmpdir(), "agent-meta-"));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const sessionDir = (sessionId) => join(TMP_ROOT, sanitizePath(REPO), sessionId);

// Two files written in the same millisecond tie on mtime, and the newest-dispatch
// strategy sorts on it. Stamp the order the assertion depends on rather than trusting
// the clock: `age` is seconds into the past, so 0 is the newest.
const stampAge = (path, age) => {
  const t = new Date(1700000000000 - age * 1000);
  utimesSync(path, t, t);
};

// A fresh module instance, because agent-meta shouts at most once per PROCESS and a
// real hook is one process per stop. Two stops means two instances.
const freshResolver = async () => {
  vi.resetModules();
  return import("../lib/agent-meta.mjs");
};

describe("readAgentMeta: the runtime's real payload shape", () => {
  test("(a) a developer stop resolves through the payload's agent id", async () => {
    const layout = runtimeLayout(TMP, "aaaa1111-1111-2222-3333-444455556666");
    spawnAgent(
      layout,
      "a1b2c3d4e5f607182",
      {
        agentType: "aiharness:developer",
        description: "Implement TASK-002: deal importance",
      },
      "ROLE: developer\nTASK_ID: TASK-002\n",
    );
    const { readAgentMeta, agentTranscriptPath } = await freshResolver();
    const payload = stopPayload(layout, "a1b2c3d4e5f607182");

    const hit = readAgentMeta(payload);
    expect(hit).not.toBe(null);
    expect(hit.source).toBe("agent-id");
    expect(hit.agentType).toBe("aiharness:developer");
    expect(hit.description).toContain("TASK-002");
    // The agent's OWN transcript, never the main one the payload handed us.
    expect(agentTranscriptPath(payload)).toBe(
      join(layout.subagents, "agent-a1b2c3d4e5f607182.jsonl"),
    );
    expect(agentTranscriptPath(payload)).not.toBe(layout.mainTranscript);
  });

  test("picks the agent named by the id, not a concurrent sibling", async () => {
    const layout = runtimeLayout(TMP, "aaaa2222-1111-2222-3333-444455556666");
    stampAge(
      spawnAgent(layout, "aoldaaaaaaaaaaaaa", {
        agentType: "developer",
        description: "Implement TASK-001",
      }),
      60,
    );
    stampAge(
      spawnAgent(layout, "anewbbbbbbbbbbbbb", {
        agentType: "merger",
        description: "Merge TASK-001",
      }),
      0,
    );
    const { readAgentMeta } = await freshResolver();
    // The merger transcript is the newest on disk; the id must still win.
    expect(
      readAgentMeta(stopPayload(layout, "aoldaaaaaaaaaaaaa")).agentType,
    ).toBe("developer");
  });

  test("an id already prefixed with agent- is not double-prefixed", async () => {
    const layout = runtimeLayout(TMP, "aaaa3333-1111-2222-3333-444455556666");
    spawnAgent(layout, "acccccccccccccccc", { agentType: "planner" });
    const { readAgentMeta } = await freshResolver();
    expect(
      readAgentMeta(stopPayload(layout, "agent-acccccccccccccccc")).agentType,
    ).toBe("planner");
  });

  test("an id with a path separator is refused, never used to build a path", async () => {
    const layout = runtimeLayout(TMP, "aaaa4444-1111-2222-3333-444455556666");
    spawnAgent(layout, "addddddddddddddddd", { agentType: "developer" });
    const { readAgentMeta } = await freshResolver();
    expect(readAgentMeta(stopPayload(layout, "../../etc/passwd"))).toBe(null);
  });

  test("resolves with no session_id in the payload, from the transcript name", async () => {
    const layout = runtimeLayout(TMP, "aaaa5555-1111-2222-3333-444455556666");
    spawnAgent(layout, "aeeeeeeeeeeeeeeee", { agentType: "merger" });
    const { readAgentMeta } = await freshResolver();
    const payload = stopPayload(layout, "aeeeeeeeeeeeeeeee");
    delete payload.session_id;
    expect(readAgentMeta(payload).agentType).toBe("merger");
  });
});

describe("readAgentMeta: fallback strategies", () => {
  test("the sibling meta still resolves when the payload IS the agent's transcript", async () => {
    const layout = runtimeLayout(TMP, "bbbb1111-1111-2222-3333-444455556666");
    const own = spawnAgent(layout, "affffffffffffffff", {
      agentType: "quality-reviewer",
      description: "Review TASK-003",
    });
    const { readAgentMeta, agentTranscriptPath } = await freshResolver();
    const payload = {
      session_id: layout.sessionId,
      transcript_path: own,
    };
    const hit = readAgentMeta(payload);
    expect(hit.source).toBe("sibling");
    expect(hit.agentType).toBe("quality-reviewer");
    expect(agentTranscriptPath(payload)).toBe(own);
  });

  test("with no agent id, the newest harness dispatch answers as a labelled guess", async () => {
    const layout = runtimeLayout(TMP, "bbbb2222-1111-2222-3333-444455556666");
    stampAge(
      spawnAgent(
        layout,
        "a00000000000000001",
        { agentType: "developer", description: "Implement TASK-001" },
        "ROLE: developer\nTASK_ID: TASK-001\n",
      ),
      60,
    );
    stampAge(
      spawnAgent(
        layout,
        "a00000000000000002",
        { agentType: "merger", description: "Merge TASK-001" },
        "ROLE: merger\nTASK_ID: TASK-001\nSTAGE: a-only\n",
      ),
      0,
    );
    const { readAgentMeta } = await freshResolver();
    const hit = readAgentMeta(stopPayload(layout));
    expect(hit.source).toBe("newest-dispatch");
    expect(hit.agentType).toBe("merger");
  });

  test("the guess skips the runtime's own helper agents, which carry no contract", async () => {
    const layout = runtimeLayout(TMP, "bbbb3333-1111-2222-3333-444455556666");
    stampAge(
      spawnAgent(
        layout,
        "a00000000000000003",
        { agentType: "developer", description: "Implement TASK-004" },
        "ROLE: developer\nTASK_ID: TASK-004\n",
      ),
      60,
    );
    stampAge(
      spawnAgent(
        layout,
        "a00000000000000004",
        { agentType: "Explore", description: "find the deal model" },
        "Search the repo for the deal model and report back.",
      ),
      0,
    );
    const { readAgentMeta } = await freshResolver();
    // Explore's transcript is the newest, but it is not a harness dispatch.
    expect(readAgentMeta(stopPayload(layout)).agentType).toBe("developer");
  });
});

describe("readAgentMeta: unresolvable identity is LOUD", () => {
  // Unresolvable identity turns every guard behind it into a no-op, and each of those
  // treats "not my role" as "not my business", so none of them can report it. Without this
  // WARN the whole family degrades with no log line at all.
  const orphanSession = (sessionId) => {
    const projectDir = join(TMP, "projects", "-workspaces-orphan");
    mkdirSync(projectDir, { recursive: true });
    const mainTranscript = join(projectDir, `${sessionId}.jsonl`);
    writeFileSync(mainTranscript, "");
    return { sessionId, mainTranscript, subagents: "" };
  };

  test("(c) returns null, warns ONCE per session, and counts the rest", async () => {
    const sessionId = "cccc1111-1111-2222-3333-444455556666";
    const layout = orphanSession(sessionId);
    // Two separate stops, i.e. two hook processes, each with its own payload object.
    for (const _ of [1, 2]) {
      const { readAgentMeta } = await freshResolver();
      expect(readAgentMeta(stopPayload(layout))).toBe(null);
    }

    const log = readFileSync(join(sessionDir(sessionId), "hooks.log"), "utf8");
    const warns = log
      .split("\n")
      .filter((l) => l.includes("WARN identity-unresolvable"));
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("[agent-meta]");
    expect(warns[0]).toContain("agent_id=absent");

    // The miss that got no line is still counted, so a later audit can recover the total.
    expect(
      readFileSync(
        join(sessionDir(sessionId), "identity-unresolvable"),
        "utf8",
      ).trim(),
    ).toBe("2");
  });

  test("one stop warns once however many hooks ask", async () => {
    const sessionId = "cccc2222-1111-2222-3333-444455556666";
    const layout = orphanSession(sessionId);
    const { readAgentMeta, agentTranscriptPath } = await freshResolver();
    const payload = stopPayload(layout);
    readAgentMeta(payload);
    readAgentMeta(payload);
    agentTranscriptPath(payload);
    expect(
      readFileSync(
        join(sessionDir(sessionId), "identity-unresolvable"),
        "utf8",
      ).trim(),
    ).toBe("1");
  });

  test("agentTranscriptPath refuses the MAIN session transcript", async () => {
    // The whole family of false positives came from reading it: it holds every dispatch
    // prompt and every orchestrator message of the session, so a scan for MODE: /
    // TASK_ID / a final APPROVED answers with whatever came first, not with what this
    // agent did.
    const layout = orphanSession("cccc3333-1111-2222-3333-444455556666");
    const { agentTranscriptPath } = await freshResolver();
    expect(agentTranscriptPath(stopPayload(layout))).toBe("");
  });

  test("an empty payload is null, not a crash", async () => {
    const { readAgentMeta, agentTranscriptPath } = await freshResolver();
    expect(readAgentMeta({})).toBe(null);
    expect(agentTranscriptPath({})).toBe("");
  });
});
