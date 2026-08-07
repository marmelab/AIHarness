import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { sanitizePath } from "../lib/paths.mjs";
import {
  runtimeLayout,
  spawnAgent,
  stopPayload,
} from "./fixtures/subagent-stop.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "completion-invariant.mjs");
const SESSION_ID = "ci9f0a1b-1111-2222-3333-444455556666";
const SHORT = "ci9f0a1b";

let TMP, APP_DIR, sessionDir, env;

const g = (...args) =>
  spawnSync("git", ["-C", APP_DIR, ...args], { encoding: "utf8" });

const sessionHead = () =>
  spawnSync("git", ["-C", APP_DIR, "rev-parse", `session/${SHORT}`], {
    encoding: "utf8",
  }).stdout.trim();

const writeE2eResult = (status, sessionSha = undefined) =>
  writeFileSync(
    join(sessionDir, "e2e-result.json"),
    JSON.stringify({
      kind: "e2e-result",
      status,
      output: "1 failed",
      ...(sessionSha === undefined ? {} : { sessionSha }),
    }),
  );

const transcriptWithMeta = (agentType) => {
  const tp = join(TMP, `agent-${Math.random().toString(36).slice(2)}.jsonl`);
  writeFileSync(tp, "");
  writeFileSync(
    tp.replace(/\.jsonl$/, ".meta.json"),
    JSON.stringify({ agentType, description: "orchestrate the feature" }),
  );
  return tp;
};

const run = (transcriptPath) =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify({
      session_id: SESSION_ID,
      hook_event_name: "SubagentStop",
      transcript_path: transcriptPath,
    }),
    env,
    encoding: "utf8",
  });

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "completion-invariant-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  sessionDir = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(APP_DIR, { recursive: true });

  g("init", "-q", "-b", "main");
  g("config", "user.email", "t@t.t");
  g("config", "user.name", "t");
  writeFileSync(join(APP_DIR, "f.txt"), "seed");
  g("add", "-A");
  g("commit", "-q", "-m", "seed");
  g("branch", `session/${SHORT}`);

  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

// TICKETS_DIR == <session_dir> (orchestrator.md "Environment"), so the reviewer's
// verdict flags live at <session_dir>/reviews/, which is what reviews.mjs resolves.
const approveTask = (taskId) => {
  const dir = join(sessionDir, "reviews");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${taskId}-quality-reviewer`), "");
};

const unmergedTaskBranch = (taskId) => {
  g("checkout", "-q", "-b", `${SHORT}/${taskId}`, `session/${SHORT}`);
  writeFileSync(join(APP_DIR, `${taskId}.txt`), "work");
  g("add", "-A");
  g("commit", "-q", "-m", `feat(${taskId}): work`);
  g("checkout", "-q", "main");
};

describe("completion-invariant — orphaned work", () => {
  test("rejects the stop when APPROVED work is not merged into the session branch", () => {
    unmergedTaskBranch("TASK-001");
    approveTask("TASK-001");
    const r = run(transcriptWithMeta("orchestrator"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("TASK-001");
  });

  test("accepts an unmerged branch with no APPROVED verdict", () => {
    unmergedTaskBranch("TASK-002");
    const r = run(transcriptWithMeta("orchestrator"));
    expect(r.status).toBe(0);
  });
});

// The marker is a claim about NOW. It was write-only: one run wrote it at 13:20:19 for a
// branch whose merger was mid-flight, the merge landed two minutes later, and the file was
// still there at the end of the session. The main thread reads it before relaying and
// session-bootstrap offers a resume from it, so a stale one sends a fresh orchestrator to
// recover work that is already merged.
describe("completion-invariant: needs-recovery is cleared when the orphan resolves", () => {
  const marker = () => join(sessionDir, "needs-recovery");

  test("a resolved orphan removes the marker", () => {
    writeFileSync(
      marker(),
      JSON.stringify({ reason: "orphaned-task-branches", branches: ["x/T-1"] }),
    );
    // Nothing unmerged and approved: the invariant holds.
    const r = run(transcriptWithMeta("orchestrator"));
    expect(r.status).toBe(0);
    expect(existsSync(marker())).toBe(false);
  });

  test("an orphan that is still orphaned keeps its marker", () => {
    unmergedTaskBranch("TASK-003");
    approveTask("TASK-003");
    // Rejected twice (the budget), then the marker is written and the stop allowed.
    run(transcriptWithMeta("orchestrator"));
    run(transcriptWithMeta("orchestrator"));
    const r = run(transcriptWithMeta("orchestrator"));
    expect(r.status).toBe(0);
    expect(existsSync(marker())).toBe(true);
    expect(JSON.parse(readFileSync(marker(), "utf8")).branches).toContain(
      `${SHORT}/TASK-003`,
    );
  });
});

describe("completion-invariant — red e2e", () => {
  test("rejects the orchestrator's stop once when the e2e suite failed", () => {
    writeE2eResult("failed");
    const r = run(transcriptWithMeta("orchestrator"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("e2e suite FAILED");
  });

  test("allows the stop on the next attempt, never wedging the pipeline", () => {
    writeE2eResult("failed");
    const tp = transcriptWithMeta("orchestrator");
    expect(run(tp).status).toBe(2);
    expect(run(tp).status).toBe(0);
  });

  test("accepts a passing suite", () => {
    writeE2eResult("passed");
    expect(run(transcriptWithMeta("orchestrator")).status).toBe(0);
  });

  test("accepts a gracefully skipped suite", () => {
    writeE2eResult("skipped");
    expect(run(transcriptWithMeta("orchestrator")).status).toBe(0);
  });

  test("accepts when no suite ran this round", () => {
    expect(run(transcriptWithMeta("orchestrator")).status).toBe(0);
  });

  test("ignores a red suite on a non-orchestrator stop", () => {
    writeE2eResult("failed");
    expect(run(transcriptWithMeta("developer")).status).toBe(0);
  });

  test("rejects a red suite recorded against the current session head", () => {
    writeE2eResult("failed", sessionHead());
    expect(run(transcriptWithMeta("orchestrator")).status).toBe(2);
  });

  test("ignores a red suite from an earlier request, whose commit has moved on", () => {
    writeE2eResult("failed", "0000000000000000000000000000000000000000");
    expect(run(transcriptWithMeta("orchestrator")).status).toBe(0);
  });

  test.each(["orchestrator", "aiharness:orchestrator"])(
    "recognises a %s stop on the runtime's real payload shape",
    (agentType) => {
      // The payload's transcript_path names the MAIN session transcript, so a
      // sibling-meta lookup resolves nothing and this invariant would never be checked
      // at all. Identity comes from the payload's agent_id.
      writeE2eResult("failed");
      const layout = runtimeLayout(
        join(TMP, `rt-${sanitizePath(agentType)}`),
        SESSION_ID,
      );
      spawnAgent(
        layout,
        "a00000000000000031",
        { agentType, description: "orchestrate the feature" },
        "ROLE: orchestrator\nMODE: wave\n",
      );
      const r = spawnSync("node", [HOOK], {
        input: JSON.stringify(stopPayload(layout, "a00000000000000031")),
        env,
        encoding: "utf8",
      });
      expect(r.status).toBe(2);
      expect(readFileSync(join(sessionDir, "hooks.log"), "utf8")).not.toContain(
        "not orchestrator",
      );
    },
  );

  test("says so when identity is unresolvable, instead of blaming the role", () => {
    writeE2eResult("failed");
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        session_id: SESSION_ID,
        hook_event_name: "SubagentStop",
        agent_type: "",
      }),
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(readFileSync(join(sessionDir, "hooks.log"), "utf8")).toContain(
      "identity unresolvable",
    );
  });

  test("keeps the e2e budget separate from the orphan-branch budget", () => {
    writeE2eResult("failed");
    const tp = transcriptWithMeta("orchestrator");
    run(tp);
    const orphanBudget = join(
      sessionDir,
      "breaker",
      "completion-invariant-rejects",
    );
    const e2eBudget = join(
      sessionDir,
      "breaker",
      "completion-invariant-e2e-rejects",
    );
    expect(spawnSync("test", ["-f", e2eBudget]).status).toBe(0);
    expect(spawnSync("test", ["-f", orphanBudget]).status).not.toBe(0);
  });
});

describe("completion-invariant: feature-smoke with no evidence", () => {
  const writeSmokeResult = (status) =>
    writeFileSync(
      join(sessionDir, "smoke-result.json"),
      JSON.stringify({ status, verdict: "APPROVED", evidence: {} }),
    );

  test("rejects the stop once when the smoke approved without driving a browser", () => {
    writeSmokeResult("approved-no-evidence");
    const r = run(transcriptWithMeta("orchestrator"));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("no browser was driven");
  });

  test("allows the stop on the next attempt, never wedging the pipeline", () => {
    writeSmokeResult("approved-no-evidence");
    const tp = transcriptWithMeta("orchestrator");
    expect(run(tp).status).toBe(2);
    expect(run(tp).status).toBe(0);
  });

  // A smoke that DID drive a browser is the normal case and must cost nothing, whether
  // it drove it through the MCP tools or from Bash.
  test.each(["approved", "blocked", "unknown"])(
    "accepts a smoke recorded as %s",
    (status) => {
      writeSmokeResult(status);
      expect(run(transcriptWithMeta("orchestrator")).status).toBe(0);
    },
  );

  test("accepts when no smoke ran this round", () => {
    expect(run(transcriptWithMeta("orchestrator")).status).toBe(0);
  });

  test("ignores an unevidenced smoke on a non-orchestrator stop", () => {
    writeSmokeResult("approved-no-evidence");
    expect(run(transcriptWithMeta("developer")).status).toBe(0);
  });

  test("keeps its budget separate from the e2e and orphan budgets", () => {
    writeSmokeResult("approved-no-evidence");
    run(transcriptWithMeta("orchestrator"));
    const budget = (name) => join(sessionDir, "breaker", name);
    expect(
      spawnSync("test", ["-f", budget("completion-invariant-smoke-rejects")])
        .status,
    ).toBe(0);
    expect(
      spawnSync("test", ["-f", budget("completion-invariant-e2e-rejects")])
        .status,
    ).not.toBe(0);
    expect(
      spawnSync("test", ["-f", budget("completion-invariant-rejects")]).status,
    ).not.toBe(0);
  });

  // The two invariants share one stop, and each spends only its own budget: the red
  // suite is raised first, and the smoke check still gets its attempt afterwards
  // instead of being swallowed by the e2e reject.
  test("a red e2e and an unevidenced smoke each get their own attempt", () => {
    writeE2eResult("failed");
    writeSmokeResult("approved-no-evidence");
    const tp = transcriptWithMeta("orchestrator");
    const first = run(tp);
    expect(first.status).toBe(2);
    expect(first.stderr).toContain("e2e suite FAILED");
    const second = run(tp);
    expect(second.status).toBe(2);
    expect(second.stderr).toContain("no browser was driven");
  });
});
