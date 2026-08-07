// Tests for record-smoke-evidence.mjs, the recorder that makes a feature-smoke
// verdict checkable: it writes <session_dir>/smoke-result.json, and never blocks.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
const HOOK = join(HERE, "..", "record-smoke-evidence.mjs");
const SESSION_ID = "5m0ke1d0-1111-2222-3333-444455556666";

let TMP, APP_DIR, sessionDir, env, layout;

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "record-smoke-evidence-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  sessionDir = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(APP_DIR, { recursive: true });
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
  layout = runtimeLayout(join(TMP, "rt"), SESSION_ID);
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

const toolUse = (name, input) =>
  JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name, input }],
    },
  }) + "\n";

/**
 * Spawn a stopping reviewer and run the hook against it.
 * @param {{mode?: string, verdict?: string, drove?: "mcp"|"bash"|null,
 *          agentId?: string, runtimeCheck?: boolean}} o
 */
const runStop = ({
  mode = "feature-smoke",
  verdict = "APPROVED",
  drove = null,
  agentId = "a5m0ke00000000001",
  runtimeCheck = false,
} = {}) => {
  const transcript = spawnAgent(
    layout,
    agentId,
    { agentType: "quality-reviewer", description: "smoke the feature" },
    `ROLE: quality-reviewer (MODE: ${mode})\nSESSION_SHORT_ID: 5m0ke1d0\n` +
      (runtimeCheck
        ? "RUNTIME_CHECK: drive these cross-ticket flows in demo mode.\n1. create a contact\n"
        : ""),
    [verdict],
  );
  if (drove === "mcp") {
    appendFileSync(
      transcript,
      toolUse("mcp__plugin_aiharness_playwright__browser_navigate", {
        url: "http://localhost:5399/",
      }),
    );
  } else if (drove === "bash") {
    appendFileSync(
      transcript,
      toolUse("Bash", {
        command: `node -e "const {chromium}=require('playwright'); await chromium.launch();"`,
      }),
    );
  }
  const r = spawnSync("node", [HOOK], {
    input: JSON.stringify(stopPayload(layout, agentId)),
    env,
    encoding: "utf8",
  });
  return r;
};

const resultFile = () => join(sessionDir, "smoke-result.json");
const result = () => JSON.parse(readFileSync(resultFile(), "utf8"));

describe("record-smoke-evidence", () => {
  test("an APPROVED smoke that drove the browser from Bash is approved", () => {
    const r = runStop({ drove: "bash" });
    expect(r.status).toBe(0);
    expect(result()).toMatchObject({
      status: "approved",
      verdict: "APPROVED",
      evidence: { bash: true, mcp: false },
    });
  });

  test("an APPROVED smoke that used the MCP tools is approved", () => {
    runStop({ drove: "mcp" });
    expect(result()).toMatchObject({
      status: "approved",
      evidence: { mcp: true },
    });
  });

  // The one judgement this hook makes: green flows, no browser anywhere.
  test("an APPROVED smoke that drove nothing is approved-no-evidence", () => {
    runStop({ drove: null });
    expect(result().status).toBe("approved-no-evidence");
  });

  test("a BLOCKED smoke is recorded as blocked, evidence or not", () => {
    runStop({ verdict: "BLOCKED: the contact list is empty", drove: null });
    expect(result().status).toBe("blocked");
  });

  test("an unparseable verdict is unknown, never approved-no-evidence", () => {
    runStop({ verdict: "I could not reach a conclusion.", drove: null });
    expect(result().status).toBe("unknown");
  });

  // Other reviewer stops are not this hook's business: a per-ticket review, and a
  // feature review that was asked for no flows, must leave no smoke result behind.
  test.each(["feature-review", "per-ticket"])(
    "writes nothing for MODE: %s",
    (mode) => {
      const r = runStop({ mode });
      expect(r.status).toBe(0);
      expect(existsSync(resultFile())).toBe(false);
    },
  );

  test("never blocks the stop, whatever it records", () => {
    expect(runStop({ drove: null }).status).toBe(0);
  });

  test("a malformed payload is fail-open", () => {
    const r = spawnSync("node", [HOOK], {
      input: "not json",
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
  });
});

// The runtime check now normally rides inside the feature-review dispatch, as a
// RUNTIME_CHECK block, rather than costing a second opus agent. The marker is what makes
// such a stop ours: the mode alone would demand browser evidence from every review,
// including reviews of diffs that change no UI at all.
describe("record-smoke-evidence: the runtime check folded into a feature-review", () => {
  test("a feature-review carrying RUNTIME_CHECK is recorded like a smoke", () => {
    const r = runStop({
      mode: "feature-review",
      runtimeCheck: true,
      drove: "bash",
    });
    expect(r.status).toBe(0);
    expect(result()).toMatchObject({
      status: "approved",
      verdict: "APPROVED",
      evidence: { bash: true },
    });
  });

  test("a RUNTIME_CHECK approved with no browser is still caught", () => {
    runStop({ mode: "feature-review", runtimeCheck: true, drove: null });
    expect(result()).toMatchObject({ status: "approved-no-evidence" });
  });

  test("a feature-review with no RUNTIME_CHECK is not asked for evidence", () => {
    const r = runStop({ mode: "feature-review", drove: null });
    expect(r.status).toBe(0);
    expect(existsSync(resultFile())).toBe(false);
  });
});
