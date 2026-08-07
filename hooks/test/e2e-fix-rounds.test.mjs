// Tests for what makes the e2e suite run, in e2e-on-feature-review.mjs.
//
// A fix round used to be dev + merge + a FULL opus feature-review whose only purpose was
// re-triggering the hook. The merger trigger removes the review from that loop, so the
// three conditions it fires on are the load-bearing part: fire on one condition too few
// and a suite runs on every merge of the wave; one too many and the fix round is back to
// paying for a review.
//
// The other property here is that the result file is always truthful. It is the only place
// the suite's verdict exists, and a reader must be able to tell "still running / killed"
// from "never ran" and from "passed".

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
const HOOK = join(HERE, "..", "e2e-on-feature-review.mjs");
const SESSION_ID = "e2ef1x00-1111-2222-3333-444455556666";
const SHORT = "e2ef1x00";

// Fails the way Playwright does, so the hook has something to build a signature from.
const SMOKE_FAIL = [
  "#!/usr/bin/env bash",
  'echo "$E2E_SMOKE_SPECS" > "${E2E_SMOKE_SRC}_specs"',
  "echo '  1) [chromium] › e2e/deal.spec.ts:12:5 › import › shows the preview'",
  "echo '    Error: expect(locator).toBeVisible() failed'",
  "exit 1",
].join("\n");
const SMOKE_PASS = [
  "#!/usr/bin/env bash",
  'echo "$E2E_SMOKE_SPECS" > "${E2E_SMOKE_SRC}_specs"',
  'echo "e2e-smoke: suite exit=0"',
  "exit 0",
].join("\n");
// Outlives the 1.5s timeout the test sets, without making the suite slow.
const SMOKE_HANG = "#!/usr/bin/env bash\nsleep 20\n";

let TMP, APP_DIR, SESSION_DIR, layout, env, agentSeq;

const g = (cwd, ...args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const writeSmoke = (body) =>
  writeFileSync(join(APP_DIR, ".claude", "scripts", "e2e-smoke.sh"), body, {
    mode: 0o755,
  });

const resultPath = () => join(SESSION_DIR, "e2e-result.json");
const result = () =>
  existsSync(resultPath())
    ? JSON.parse(readFileSync(resultPath(), "utf8"))
    : null;
const ranMarker = () => join(SESSION_DIR, "_session_specs");
const didRun = () => existsSync(ranMarker());
const clearRun = () => rmSync(ranMarker(), { force: true });

const approveFeature = () => {
  mkdirSync(join(SESSION_DIR, "reviews"), { recursive: true });
  writeFileSync(join(SESSION_DIR, "reviews", "FEATURE-quality-reviewer"), "");
};

const headSha = () => g(APP_DIR, "rev-parse", `session/${SHORT}`).stdout.trim();

const seedResult = (patch) =>
  writeFileSync(
    resultPath(),
    JSON.stringify({
      kind: "e2e-result",
      status: "failed",
      sessionSha: headSha(),
      output:
        "  1) [chromium] › e2e/deal.spec.ts:12:5 › import\n    Error: boom",
      ...patch,
    }),
  );

// Merge one commit into the session branch, the way a fix-round merger does.
const mergeAFix = (name) => {
  writeFileSync(join(APP_DIR, `${name}.ts`), `export const ${name} = 1;\n`);
  g(APP_DIR, "add", "-A");
  g(APP_DIR, "commit", "-q", "-m", `fix: ${name}`);
  return headSha();
};

const stop = (agentType, { prompt = "", extraEnv = {} } = {}) => {
  const id = `a00000000000000${(agentSeq++).toString().padStart(2, "0")}`;
  spawnAgent(
    layout,
    id,
    { agentType, description: `${agentType} work` },
    prompt,
  );
  return spawnSync("node", [HOOK], {
    input: JSON.stringify(stopPayload(layout, id)),
    env: { ...env, ...extraEnv },
    encoding: "utf8",
  });
};

const mergerStop = (opts) => stop("aiharness:merger", opts);
const featureReviewStop = (opts = {}) =>
  stop("aiharness:quality-reviewer", {
    prompt: "ROLE: quality-reviewer\nMODE: feature-review\n",
    ...opts,
  });

beforeEach(() => {
  agentSeq = 10;
  TMP = mkdtempSync(join(tmpdir(), "e2e-fix-rounds-"));
  APP_DIR = join(TMP, "app");
  const TMP_ROOT = join(TMP, "scratch");
  SESSION_DIR = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(join(SESSION_DIR, "_session"), { recursive: true });
  mkdirSync(join(APP_DIR, ".claude", "scripts"), { recursive: true });

  g(APP_DIR, "init", "-q", "-b", "main");
  g(APP_DIR, "config", "user.email", "t@t.t");
  g(APP_DIR, "config", "user.name", "t");
  writeFileSync(join(APP_DIR, "seed.ts"), "export const a = 1;\n");
  g(APP_DIR, "add", "-A");
  g(APP_DIR, "commit", "-q", "-m", "seed");
  g(APP_DIR, "branch", `session-base/${SHORT}`);
  g(APP_DIR, "branch", `session/${SHORT}`);
  g(APP_DIR, "checkout", "-q", `session/${SHORT}`);

  writeSmoke(SMOKE_FAIL);
  layout = runtimeLayout(join(TMP, "transcripts"), SESSION_ID);
  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.E2E_TIMEOUT_MS;
});

afterEach(() => rmSync(TMP, { recursive: true, force: true }));

describe("the merger trigger needs all three conditions", () => {
  test("all three hold: the suite runs without any reviewer", () => {
    approveFeature();
    seedResult({ status: "failed", sessionSha: headSha() });
    mergeAFix("patch");
    expect(mergerStop().status).toBe(0);
    expect(didRun()).toBe(true);
    expect(result().trigger).toBe("merger-fix");
  });

  test("no FEATURE flag: a merge during the wave runs nothing", () => {
    seedResult({ status: "failed", sessionSha: headSha() });
    mergeAFix("wave-ticket");
    mergerStop();
    expect(didRun()).toBe(false);
  });

  test("the last result passed: nothing to re-run", () => {
    approveFeature();
    seedResult({ status: "passed", sessionSha: headSha() });
    mergeAFix("patch");
    mergerStop();
    expect(didRun()).toBe(false);
  });

  test("no result at all: the feature review has not run the suite yet", () => {
    approveFeature();
    mergeAFix("patch");
    mergerStop();
    expect(didRun()).toBe(false);
  });

  // The suite writes `running` before it starts so a killed process is distinguishable
  // from "never ran". That record survives the process, so a trigger that only accepts
  // `failed` left the session unable to verify any later fix: the wave ends on a verdict
  // nobody produced.
  test("a `running` left by a dead process is re-run when a fix lands", () => {
    approveFeature();
    seedResult({
      status: "running",
      // A pid that cannot be alive: the hook must not treat it as a suite in flight.
      pid: 0x7fffffff,
      sessionSha: headSha(),
    });
    mergeAFix("patch");
    expect(mergerStop().status).toBe(0);
    expect(didRun()).toBe(true);
    expect(result().trigger).toBe("merger-fix");
  });

  test("a `running` from a live process is left alone", () => {
    approveFeature();
    // This test process is alive by definition, so the record reads as a suite in flight.
    seedResult({ status: "running", pid: process.pid, sessionSha: headSha() });
    mergeAFix("patch");
    mergerStop();
    expect(didRun()).toBe(false);
  });

  test("nothing merged since the failure: no re-run on the same code", () => {
    approveFeature();
    seedResult({ status: "failed", sessionSha: headSha() });
    // A merger stop with the session branch exactly where the suite already ran.
    mergerStop();
    expect(didRun()).toBe(false);
  });

  test("a non-merger stop never triggers it", () => {
    approveFeature();
    seedResult({ status: "failed", sessionSha: headSha() });
    mergeAFix("patch");
    stop("aiharness:developer");
    expect(didRun()).toBe(false);
    stop("aiharness:quality-reviewer", {
      prompt: "ROLE: quality-reviewer\nTASK_ID: TASK-001\n",
    });
    expect(didRun()).toBe(false);
  });
});

describe("the result file is always truthful", () => {
  test("a killed suite leaves `running`, not a stale pass and not nothing", () => {
    approveFeature();
    seedResult({
      status: "passed",
      sessionSha: "0000000000000000000000000000000000000000",
    });
    writeSmoke(SMOKE_HANG);
    // The real budget is 13 minutes; the point under test is that the hook's own timeout
    // fires before the runtime's and still writes a verdict.
    const r = featureReviewStop({ extraEnv: { E2E_TIMEOUT_MS: "1500" } });
    expect(r.status).toBe(0);
    // The hook's own timeout fired, so it still wrote a verdict rather than being killed
    // mid-run and leaving the reader with the deleted previous result.
    const out = result();
    expect(out.status).toBe("failed");
    expect(out.timedOut).toBe(true);
    expect(out.output).toContain("TIMEOUT");
    expect(out.startedAt).toBeTruthy();
  });

  test("a `running` marker exists while the suite is in flight", () => {
    // The smoke script reads the result file mid-run, which is only possible if the hook
    // wrote it before launching.
    approveFeature();
    writeSmoke(
      [
        "#!/usr/bin/env bash",
        `cp "${resultPath()}" "${join(SESSION_DIR, "seen-midrun.json")}"`,
        "exit 0",
      ].join("\n"),
    );
    featureReviewStop();
    const midrun = JSON.parse(
      readFileSync(join(SESSION_DIR, "seen-midrun.json"), "utf8"),
    );
    expect(midrun.status).toBe("running");
    expect(midrun.startedAt).toBeTruthy();
  });

  test("a failure records which failure it was", () => {
    approveFeature();
    featureReviewStop();
    expect(result().status).toBe("failed");
    expect(result().failureSignature).toMatch(/^[0-9a-f]{12}$/);
  });

  test("a pass records no signature", () => {
    approveFeature();
    writeSmoke(SMOKE_PASS);
    featureReviewStop();
    expect(result().status).toBe("passed");
    expect(result().failureSignature).toBe("");
  });
});

describe("changed specs are handed to the suite", () => {
  test("specs the session touched are passed through, and recorded", () => {
    approveFeature();
    mkdirSync(join(APP_DIR, "e2e"), { recursive: true });
    writeFileSync(join(APP_DIR, "e2e", "deal.spec.ts"), "// spec\n");
    writeFileSync(join(APP_DIR, "e2e", "helper.ts"), "// not a spec\n");
    g(APP_DIR, "add", "-A");
    g(APP_DIR, "commit", "-q", "-m", "feat: add a spec");

    featureReviewStop();
    expect(readFileSync(ranMarker(), "utf8").trim()).toBe("e2e/deal.spec.ts");
    expect(result().specsFirst).toEqual(["e2e/deal.spec.ts"]);
  });

  test("no changed spec means the full suite, as before", () => {
    approveFeature();
    featureReviewStop();
    expect(readFileSync(ranMarker(), "utf8").trim()).toBe("");
    expect(result().specsFirst).toEqual([]);
  });
});

// The end-to-end budget: three defects surfacing one after another, which is what the
// global fix-round bound could not survive.
describe("a three-defect fix loop", () => {
  test("each fix re-runs the suite with no feature-review dispatch", () => {
    approveFeature();

    // Round 0: the feature review runs the suite, and it fails.
    featureReviewStop();
    expect(result().status).toBe("failed");
    const firstSignature = result().failureSignature;
    clearRun();

    // Rounds 1 and 2: fix, merge, and the merger's stop re-runs the suite by itself.
    for (const fix of ["locator-1", "locator-2"]) {
      mergeAFix(fix);
      expect(mergerStop().status).toBe(0);
      expect(didRun()).toBe(true);
      expect(result().trigger).toBe("merger-fix");
      clearRun();
    }

    // Round 3: a DIFFERENT defect, which a global budget would never have reached.
    writeSmoke(
      [
        "#!/usr/bin/env bash",
        'echo "$E2E_SMOKE_SPECS" > "${E2E_SMOKE_SRC}_specs"',
        "echo '  1) [chromium] › e2e/deal.spec.ts:40:3 › import › parses the csv'",
        "echo '    TypeError: papaparse_1.default.parse is not a function'",
        "exit 1",
      ].join("\n"),
    );
    mergeAFix("interop");
    mergerStop();
    expect(didRun()).toBe(true);
    // A new signature is what resets the orchestrator's per-failure budget, so this bug
    // gets its own fix rounds instead of inheriting an exhausted global one.
    expect(result().failureSignature).not.toBe(firstSignature);

    // And the whole loop dispatched no reviewer: every re-run came from a merger stop.
    expect(result().trigger).toBe("merger-fix");
  });
});
