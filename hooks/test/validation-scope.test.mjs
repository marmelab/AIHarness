// Tests for WHAT the validation chain is allowed to touch, in validate-on-stop.mjs and
// lib/validation.mjs.
//
// A full-run audit of session 13afe5d3 measured the failure these lock down: 212 chains
// ran for about 12 that were needed, and 202 of them ran UNSCOPED over every session
// worktree, because the stopping agent's identity was unresolvable and the code fell back
// to wt=all. TASK-002 was re-validated 33 times, some chains 1.6 seconds apart, and was
// still being validated 25 minutes after it was DONE. Along the way 34 dirty-stop
// rejections were raised and 9 fallback commits made, mostly against worktrees whose own
// developer was still mid-edit.
//
// The old suite could not see any of it: it passed `transcript_path: "/nonexistent.jsonl"`
// and no identity, which is precisely the payload the storm came from, and asserted only
// that the chain ran.

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
const HOOK = join(HERE, "..", "validate-on-stop.mjs");
const SESSION_ID = "sc0pe123-1111-2222-3333-444455556666";
const SHORT = "sc0pe123";

// One always-failing unit step: a chain that RAN is then unmistakable (exit 2), and a
// chain that was skipped is equally unmistakable (exit 0).
const CONFIG = {
  validation: {
    steps: [{ id: "unit-app", kind: "unit", command: "false" }],
    extraForbidden: [],
  },
  roles: {
    developer: { validate: true, model: "sonnet" },
    "simple-developer": { validate: true, model: "sonnet" },
    "test-writer": { validate: true, model: "sonnet" },
    "quality-reviewer": { validate: false, model: "opus" },
    merger: { validate: false, model: "haiku" },
    orchestrator: { validate: false, model: "sonnet" },
  },
};

let TMP, APP_DIR, TMP_ROOT, SESSION_DIR, layout, env;

const g = (cwd, ...args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

const hookLog = () => {
  const p = join(SESSION_DIR, "hooks.log");
  return existsSync(p) ? readFileSync(p, "utf8") : "";
};

// A dirty task worktree with one committed change, so the chain has something to validate.
const addWorktree = (name) => {
  const wt = join(SESSION_DIR, name);
  g(
    APP_DIR,
    "worktree",
    "add",
    "-q",
    "-b",
    `${SHORT}/${name}`,
    wt,
    `session/${SHORT}`,
  );
  writeFileSync(join(wt, `${name}.ts`), `export const x = "${name}";\n`);
  g(wt, "add", "-A");
  g(wt, "commit", "-q", "-m", `feat(${name}): work`);
  return wt;
};

const stop = (agentId) =>
  spawnSync("node", [HOOK], {
    input: JSON.stringify(stopPayload(layout, agentId)),
    env,
    encoding: "utf8",
  });

// Register one agent's spawn meta + dispatch prompt in the session's transcript layout.
const agent = (agentId, agentType, description, prompt = "") =>
  spawnAgent(layout, agentId, { agentType, description }, prompt);

beforeEach(() => {
  TMP = mkdtempSync(join(tmpdir(), "validation-scope-"));
  APP_DIR = join(TMP, "app");
  TMP_ROOT = join(TMP, "scratch");
  SESSION_DIR = join(TMP_ROOT, sanitizePath(APP_DIR), SESSION_ID);
  mkdirSync(APP_DIR, { recursive: true });
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(join(APP_DIR, "harness.config.json"), JSON.stringify(CONFIG));

  g(APP_DIR, "init", "-q", "-b", "main");
  g(APP_DIR, "config", "user.email", "t@t.t");
  g(APP_DIR, "config", "user.name", "t");
  writeFileSync(join(APP_DIR, "seed.ts"), "export const a = 1;\n");
  g(APP_DIR, "add", "-A");
  g(APP_DIR, "commit", "-q", "-m", "seed");
  g(APP_DIR, "branch", `session/${SHORT}`);

  layout = runtimeLayout(join(TMP, "transcripts"), SESSION_ID);

  env = { ...process.env, APP_DIR, HARNESS_TMP_ROOT: TMP_ROOT };
  delete env.VALIDATE_DRY_RUN;
  delete env.VALIDATE_WORKTREE;
  delete env.VALIDATE_NO_CACHE;
  delete env.CLAUDE_PROJECT_DIR;
  delete env.CHAT_SESSION_DIR;
  delete env.CLAUDE_AGENT_NAME;
});

afterEach(() => {
  for (const e of g(APP_DIR, "worktree", "list", "--porcelain")
    .stdout.split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length))) {
    if (e !== APP_DIR) g(APP_DIR, "worktree", "remove", "--force", e);
  }
  rmSync(TMP, { recursive: true, force: true });
});

describe("gate 1: identity", () => {
  test("an unresolvable identity validates nothing", () => {
    addWorktree("TASK-001");
    // No agent_id and no spawn meta: exactly the payload that produced 202 unscoped chains.
    const r = spawnSync("node", [HOOK], {
      input: JSON.stringify({
        session_id: SESSION_ID,
        hook_event_name: "SubagentStop",
        agent_type: "",
        transcript_path: layout.mainTranscript,
      }),
      env,
      encoding: "utf8",
    });
    expect(r.status).toBe(0);
    expect(hookLog()).toContain("identity unresolvable");
    expect(hookLog()).not.toContain("START");
  });
});

describe("gate 2: role", () => {
  test.each([
    ["quality-reviewer", "Review TASK-001"],
    ["aiharness:merger", "Merge TASK-001"],
    ["orchestrator", "orchestrate the feature"],
    ["planner", "plan the feature"],
  ])("a %s stop validates nothing", (agentType, description) => {
    addWorktree("TASK-001");
    agent("a00000000000000101", agentType, description);
    const r = stop("a00000000000000101");
    expect(r.status).toBe(0);
    expect(hookLog()).toContain(`skip: ${agentType} stop`);
    expect(hookLog()).not.toContain("START");
  });

  test.each(["developer", "aiharness:developer", "test-writer"])(
    "a %s stop does run the chain",
    (agentType) => {
      addWorktree("TASK-001");
      agent("a00000000000000102", agentType, "Implement TASK-001: work");
      expect(stop("a00000000000000102").status).toBe(2);
      expect(hookLog()).toContain("wt=" + join(SESSION_DIR, "TASK-001"));
    },
  );
});

describe("gate 3: worktree attribution", () => {
  test("a developer whose ticket cannot be recovered validates nothing", () => {
    addWorktree("TASK-001");
    // A real developer, but nothing names its worktree: no TASK id in the description,
    // no TASK_ID or BRANCH_NAME in the dispatch prompt.
    agent(
      "a00000000000000103",
      "developer",
      "do the thing",
      "ROLE: developer\n",
    );
    const r = stop("a00000000000000103");
    expect(r.status).toBe(0);
    expect(hookLog()).toContain("no worktree attributable");
    expect(hookLog()).not.toContain("START");
  });

  test("a simple-developer is attributed to the /simple worktree", () => {
    addWorktree("simple");
    agent("a00000000000000104", "simple-developer", "Generate the migration");
    expect(stop("a00000000000000104").status).toBe(2);
    expect(hookLog()).toContain("wt=" + join(SESSION_DIR, "simple"));
  });

  test("a plain developer on <short>/simple is attributed from BRANCH_NAME", () => {
    addWorktree("simple");
    agent(
      "a00000000000000105",
      "developer",
      "Fix the failing e2e",
      `ROLE: developer\nBRANCH_NAME: ${SHORT}/simple\n`,
    );
    expect(stop("a00000000000000105").status).toBe(2);
    expect(hookLog()).toContain("wt=" + join(SESSION_DIR, "simple"));
  });
});

describe("no unscoped sweep", () => {
  // The core regression. TASK-002's developer was still working while TASK-001's stop swept
  // its tree: same "shared brakes" failure the scoping was introduced to prevent.
  test("a TASK-001 stop never touches TASK-002's worktree", () => {
    addWorktree("TASK-001");
    addWorktree("TASK-002");
    agent("a00000000000000106", "developer", "Implement TASK-001: work");
    expect(stop("a00000000000000106").status).toBe(2);

    const log = hookLog();
    expect(log).toContain(join(SESSION_DIR, "TASK-001"));
    expect(log).not.toContain(join(SESSION_DIR, "TASK-002"));
    expect(log).not.toContain("wt=all");
  });

  // A vanished worktree used to fall through to "then validate all of them".
  test("a vanished own worktree validates nothing, rather than everything", () => {
    addWorktree("TASK-002");
    agent("a00000000000000107", "developer", "Implement TASK-001: work");
    const r = stop("a00000000000000107");
    expect(r.status).toBe(0);
    expect(hookLog()).not.toContain(join(SESSION_DIR, "TASK-002"));
  });

  // The merger's integration worktree holds work whose tickets were each validated on
  // their own branch, and nobody stops "as" _session.
  test("the _session worktree is excluded from the un-narrowed listing", () => {
    addWorktree("TASK-001");
    const sessionWt = join(SESSION_DIR, "_session");
    g(APP_DIR, "worktree", "add", "-q", sessionWt, `session/${SHORT}`);

    // validate-on-stop always narrows to one worktree now, so the un-narrowed branch is
    // only reachable from another caller. Exercise it directly, in a process whose APP_DIR
    // is this fixture repo (lib/paths.mjs reads it once at import time).
    const driver = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { getActiveWorktrees } from ${JSON.stringify(join(HERE, "..", "lib", "validation.mjs"))};` +
          `console.log(JSON.stringify(getActiveWorktrees({ worktreeBase: process.env.SCOPE_BASE })));`,
      ],
      { env: { ...env, SCOPE_BASE: SESSION_DIR }, encoding: "utf8" },
    );
    expect(driver.status).toBe(0);
    const active = JSON.parse(driver.stdout);
    expect(active).toContain(join(SESSION_DIR, "TASK-001"));
    expect(active).not.toContain(sessionWt);
  });
});

// 34 dirty-stop rejections and 9 fallback commits were made in the audited run, mostly by
// OTHER agents' stops sweeping a worktree whose developer was still mid-edit. Scoping the
// hook makes that unreachable; this makes it STRUCTURAL, so a future caller that passes a
// wider worktree set cannot resurrect it. Driven through runValidationSteps directly,
// because a mismatched owner is exactly what the hook can no longer produce.
describe("only the owner's worktree is ever written to", () => {
  const chain = (worktree, owner) =>
    spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        `import { createHookContext } from ${JSON.stringify(join(HERE, "..", "lib", "context.mjs"))};` +
          `import { runValidationSteps } from ${JSON.stringify(join(HERE, "..", "lib", "validation.mjs"))};` +
          `const ctx = createHookContext({ session_id: ${JSON.stringify(SESSION_ID)} }, "validate");` +
          `console.log(JSON.stringify(runValidationSteps(ctx, { worktree: process.env.C_WT, base: "", owner: process.env.C_OWNER })));`,
      ],
      {
        env: { ...env, C_WT: worktree, C_OWNER: owner },
        encoding: "utf8",
      },
    );

  const formatConfig = () =>
    writeFileSync(
      join(APP_DIR, "harness.config.json"),
      JSON.stringify({
        ...CONFIG,
        validation: {
          steps: [
            {
              id: "prettier",
              kind: "format",
              command: "true",
              autoCommit: true,
              extensions: [".ts"],
            },
          ],
          extraForbidden: [],
        },
      }),
    );

  test("a dirty worktree that is not ours is neither rejected nor committed", () => {
    const wt = addWorktree("TASK-002");
    formatConfig();
    writeFileSync(join(wt, "TASK-002.ts"), "export const x = 'mid-edit';\n");
    const before = g(wt, "rev-parse", "HEAD").stdout.trim();

    const r = chain(wt, join(SESSION_DIR, "TASK-001"));
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).ok).toBe(true);
    // The other developer's work is untouched: still uncommitted, HEAD unmoved.
    expect(g(wt, "status", "--porcelain").stdout.trim()).not.toBe("");
    expect(g(wt, "rev-parse", "HEAD").stdout.trim()).toBe(before);
    expect(hookLog()).toContain("dirty but not ours");
  });

  test("the same dirty worktree IS rejected when it is ours", () => {
    const wt = addWorktree("TASK-002");
    formatConfig();
    writeFileSync(join(wt, "TASK-002.ts"), "export const x = 'mid-edit';\n");
    const r = chain(wt, wt);
    expect(JSON.parse(r.stdout).step).toBe("uncommitted");
  });

  test("a foreign dirty worktree never consumes the dirty-work budget", () => {
    const wt = addWorktree("TASK-002");
    formatConfig();
    writeFileSync(join(wt, "TASK-002.ts"), "export const x = 'mid-edit';\n");
    chain(wt, join(SESSION_DIR, "TASK-001"));
    chain(wt, join(SESSION_DIR, "TASK-001"));
    chain(wt, join(SESSION_DIR, "TASK-001"));
    // Three foreign passes did not spend the budget, so the OWNER still gets its full
    // allowance of rejections rather than an immediate fallback commit.
    expect(JSON.parse(chain(wt, wt).stdout).step).toBe("uncommitted");
  });
});

describe("green cache", () => {
  // TASK-001 ran 9 chains for 3 distinct green states; TASK-002 ran 33.
  const greenConfig = () =>
    writeFileSync(
      join(APP_DIR, "harness.config.json"),
      JSON.stringify({
        ...CONFIG,
        validation: {
          steps: [{ id: "unit-app", kind: "unit", command: "true" }],
          extraForbidden: [],
        },
      }),
    );

  test("an unchanged worktree is not re-validated", () => {
    addWorktree("TASK-001");
    greenConfig();
    agent("a00000000000000108", "developer", "Implement TASK-001: work");

    expect(stop("a00000000000000108").status).toBe(0);
    expect(hookLog()).toContain("OK wt=");

    rmSync(join(SESSION_DIR, "hooks.log"), { force: true });
    expect(stop("a00000000000000108").status).toBe(0);
    expect(hookLog()).toContain("unchanged since last green");
    expect(hookLog()).not.toContain("OK wt=");
  });

  test("a new commit invalidates the cache", () => {
    const wt = addWorktree("TASK-001");
    greenConfig();
    agent("a00000000000000109", "developer", "Implement TASK-001: work");
    stop("a00000000000000109");

    writeFileSync(join(wt, "more.ts"), "export const y = 2;\n");
    g(wt, "add", "-A");
    g(wt, "commit", "-q", "-m", "feat(TASK-001): more");
    rmSync(join(SESSION_DIR, "hooks.log"), { force: true });
    stop("a00000000000000109");
    expect(hookLog()).toContain("OK wt=");
  });

  test("an uncommitted edit invalidates the cache", () => {
    const wt = addWorktree("TASK-001");
    greenConfig();
    agent("a00000000000000110", "developer", "Implement TASK-001: work");
    stop("a00000000000000110");

    writeFileSync(join(wt, "TASK-001.ts"), "export const x = 'edited';\n");
    rmSync(join(SESSION_DIR, "hooks.log"), { force: true });
    stop("a00000000000000110");
    expect(hookLog()).not.toContain("unchanged since last green");
  });

  test("a failing chain is never cached", () => {
    addWorktree("TASK-001");
    agent("a00000000000000111", "developer", "Implement TASK-001: work");
    expect(stop("a00000000000000111").status).toBe(2);
    // Still red on the next stop: a cache hit here would have reported a green log line
    // for a chain that never passed.
    expect(stop("a00000000000000111").status).toBe(2);
  });
});

// The acceptance check for the whole change: replay a stop sequence shaped like the audited
// run's and count what the chain actually did. Before this, the same sequence produced 212
// chains, 202 of them unscoped, and 9 commits the agents did not write.
describe("replaying the audited run's stop sequence", () => {
  test("one chain per changed developer stop, no sweep, no commit made for anyone", () => {
    writeFileSync(
      join(APP_DIR, "harness.config.json"),
      JSON.stringify({
        ...CONFIG,
        validation: {
          steps: [
            {
              id: "prettier",
              kind: "format",
              command: "true",
              autoCommit: true,
              extensions: [".ts"],
            },
            { id: "unit-app", kind: "unit", command: "true" },
          ],
          extraForbidden: [],
        },
      }),
    );

    const tasks = ["TASK-001", "TASK-002", "TASK-003"];
    const worktrees = Object.fromEntries(tasks.map((t) => [t, addWorktree(t)]));

    // The cast of the audited run: one developer per ticket, plus the reviewers, mergers,
    // planner and orchestrator whose stops all fired this same hook.
    tasks.forEach((t, i) => {
      agent(
        `a0000000000000d0${i}`,
        "aiharness:developer",
        `Implement ${t}: work`,
      );
      agent(
        `a0000000000000r0${i}`,
        "aiharness:quality-reviewer",
        `Review ${t}`,
      );
      agent(`a0000000000000m0${i}`, "aiharness:merger", `Merge ${t}`);
    });
    agent("a0000000000000o00", "aiharness:orchestrator", "orchestrate");
    agent("a0000000000000p00", "aiharness:planner", "plan");

    // Two rounds. Each developer commits something new before its own stop, so each of its
    // stops is a genuinely new state; every other role just stops, repeatedly, the way they
    // did on the real run.
    let devStops = 0;
    for (let round = 0; round < 2; round++) {
      tasks.forEach((t, i) => {
        writeFileSync(
          join(worktrees[t], `r${round}.ts`),
          `export const r = ${round};\n`,
        );
        g(worktrees[t], "add", "-A");
        g(worktrees[t], "commit", "-q", "-m", `feat(${t}): round ${round}`);
        expect(stop(`a0000000000000d0${i}`).status).toBe(0);
        devStops++;
        // The siblings' stops, interleaved as they were in the real run.
        stop(`a0000000000000r0${i}`);
        stop(`a0000000000000m0${i}`);
        stop("a0000000000000o00");
        stop("a0000000000000p00");
      });
      // And the developers stopping again with nothing changed, which is where 33 of
      // TASK-002's chains came from.
      tasks.forEach((_, i) => stop(`a0000000000000d0${i}`));
    }

    const lines = hookLog().split("\n");
    const count = (needle) => lines.filter((l) => l.includes(needle)).length;

    // 36 stops in total. Only the 12 developer stops get past the three gates at all...
    expect(count("START role=")).toBe(devStops * 2);
    expect(count("skip:")).toBe(24); // reviewer / merger / planner / orchestrator stops
    // ...and of those, only the 6 with a new state actually run a chain. The repeat stops,
    // which is where 33 of TASK-002's chains came from, hit the green cache instead.
    expect(count("OK wt=")).toBe(devStops);
    expect(count("unchanged since last green")).toBe(devStops);
    expect(lines.join("\n")).not.toContain("wt=all");

    // Nothing was committed on any agent's behalf, in any worktree.
    for (const wt of Object.values(worktrees)) {
      const subjects = g(wt, "log", "--format=%s").stdout;
      expect(subjects).not.toContain("commit work the");
      expect(subjects).not.toContain("style(");
      expect(g(wt, "status", "--porcelain").stdout.trim()).toBe("");
    }
  });
});

describe("per-worktree lock", () => {
  // Two interleaved chains 7 seconds apart raced on the git index through the formatter's
  // auto-commit step. The loser skips rather than waits: it would only re-validate the
  // same state.
  test("a held lock makes the chain skip that worktree", () => {
    addWorktree("TASK-001");
    agent("a00000000000000112", "developer", "Implement TASK-001: work");
    mkdirSync(join(SESSION_DIR, "locks", "validate-TASK-001.lock"), {
      recursive: true,
    });

    const r = stop("a00000000000000112");
    expect(r.status).toBe(0);
    expect(hookLog()).toContain("another validation chain holds the lock");
  });

  test("the lock is released, so the next stop validates normally", () => {
    addWorktree("TASK-001");
    agent("a00000000000000113", "developer", "Implement TASK-001: work");
    expect(stop("a00000000000000113").status).toBe(2);
    expect(
      existsSync(join(SESSION_DIR, "locks", "validate-TASK-001.lock")),
    ).toBe(false);
    expect(stop("a00000000000000113").status).toBe(2);
  });

  // The lock must not be a file inside the tree being validated: an untracked lock
  // directory there feeds both the dirty-work check and the green cache's key.
  test("the lock never makes the validated worktree dirty", () => {
    const wt = addWorktree("TASK-001");
    agent("a00000000000000114", "developer", "Implement TASK-001: work");
    stop("a00000000000000114");
    expect(g(wt, "status", "--porcelain").stdout.trim()).toBe("");
  });
});
