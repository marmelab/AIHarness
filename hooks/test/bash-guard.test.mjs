// Tests for bash-guard.mjs — browser rules (any caller) and validation-command rules (gated agents only). Blocks are decision JSON on stdout with exit 0; allowed commands produce no decision.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterAll, describe, test, expect } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = join(HERE, "..", "bash-guard.mjs");

const tmpRoot = mkdtempSync(join(tmpdir(), "bash-guard-tmp-"));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
  rmSync(standardRepo, { recursive: true, force: true });
});

// The guard derives its categories from the CONSUMING project's config, so these tests
// pin their own instead of inheriting whatever repo happens to host the core: a shared
// core must not have its test outcomes depend on its host's validation steps.
const STANDARD_CONFIG = {
  validation: {
    steps: [
      { id: "prettier", kind: "format", command: "npx prettier --write" },
      { id: "typecheck", kind: "typecheck", command: "npm run typecheck" },
      { id: "lint", kind: "lint", command: "npx eslint", changedScoped: true },
      { id: "unit", kind: "unit", runner: "vitest", changedScoped: true },
    ],
    extraForbidden: ["build", "e2e"],
  },
  roles: {
    developer: { model: "sonnet" },
    "quality-reviewer": { model: "opus" },
  },
};

const standardRepo = mkdtempSync(join(tmpdir(), "bash-guard-standard-"));
writeFileSync(
  join(standardRepo, "harness.config.json"),
  JSON.stringify(STANDARD_CONFIG),
);

const SESSION_ID = "test-1234";

const runHook = (agent, command) => {
  const env = {
    ...process.env,
    HARNESS_TMP_ROOT: tmpRoot,
    APP_DIR: standardRepo,
  };
  delete env.CLAUDE_AGENT_NAME;
  delete env.CLAUDE_PROJECT_DIR;
  const input = JSON.stringify({
    tool_name: "Bash",
    agent_type: agent,
    session_id: SESSION_ID,
    tool_input: { command },
  });
  return spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
};

// Run the hook against a temp repo whose harness.config.json we control, so we
// can prove the forbidden-command set is DERIVED from config.validation.
const runHookWithConfig = (agent, command, config) => {
  const repo = mkdtempSync(join(tmpdir(), "bash-guard-repo-"));
  writeFileSync(join(repo, "harness.config.json"), JSON.stringify(config));
  const env = { ...process.env, HARNESS_TMP_ROOT: tmpRoot, APP_DIR: repo };
  delete env.CLAUDE_AGENT_NAME;
  delete env.CLAUDE_PROJECT_DIR;
  const input = JSON.stringify({
    tool_name: "Bash",
    agent_type: agent,
    session_id: "test-1234",
    tool_input: { command },
  });
  const r = spawnSync("node", [HOOK], { input, env, encoding: "utf8" });
  rmSync(repo, { recursive: true, force: true });
  return r;
};

const isBlocked = (r) => r.stdout.includes('"decision":"block"');

describe("bash-guard hook", () => {
  describe("browser rules — any caller", () => {
    test("playwright test --headed from main session → blocked", () => {
      const r = runHook("", "npx playwright test --headed");
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(true);
      expect(r.stdout).toContain("--headed");
    });

    test("playwright test --ui / --debug → blocked", () => {
      expect(isBlocked(runHook("", "npx playwright test --ui"))).toBe(true);
      expect(isBlocked(runHook("", "npx playwright test --debug"))).toBe(true);
    });

    test("playwright open / codegen from merger → blocked", () => {
      expect(
        isBlocked(
          runHook("merger", "npx playwright open http://localhost:5173"),
        ),
      ).toBe(true);
      expect(isBlocked(runHook("merger", "npx playwright codegen"))).toBe(true);
    });

    test("headless playwright subcommand from main session → allowed", () => {
      const r = runHook("", "npx playwright show-report");
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(false);
    });

    // `npx playwright test` IS refused, but by the e2e rule below (no agent launches
    // the suite), never for a missing --headless flag the CLI cannot even accept.
    test("plain playwright test is refused for e2e, not for headlessness", () => {
      const r = runHook("", "npx playwright test");
      expect(isBlocked(r)).toBe(true);
      expect(r.stdout).toContain("e2e-on-feature-review");
      expect(r.stdout).not.toContain("--headed");
    });

    test("playwright screenshot from merger → allowed (headless default)", () => {
      const r = runHook(
        "merger",
        "npx playwright screenshot http://localhost:5173 out.png",
      );
      expect(isBlocked(r)).toBe(false);
    });

    test("playwright MCP cli with --headless → allowed", () => {
      const r = runHook(
        "",
        "node node_modules/@playwright/mcp/cli.js --headless --isolated",
      );
      expect(isBlocked(r)).toBe(false);
    });

    test("vite --open → blocked", () => {
      const r = runHook("", "npm run dev -- --open");
      expect(isBlocked(r)).toBe(true);
    });

    test("vite without --open → allowed", () => {
      const r = runHook("", "npm run dev");
      expect(isBlocked(r)).toBe(false);
    });
  });

  describe("validation rules — gated agents only", () => {
    const cases = [
      ["developer", "npm run typecheck"],
      ["developer", "npx tsc --noEmit"],
      ["developer", "npx vitest run"],
      ["developer", "npm run prettier:apply"],
      ["quality-reviewer", "npx playwright test"],
      ["quality-reviewer", "make lint"],
      ["developer", "npm run build"],
    ];

    test.each(cases)("%s running '%s' → blocked", (agent, command) => {
      const r = runHook(agent, command);
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(true);
    });

    test("non-gated agent running validation command → allowed", () => {
      const r = runHook("merger", "npm run typecheck");
      expect(isBlocked(r)).toBe(false);
    });

    // e2e is the one category scoped to EVERY caller: launching the suite is the
    // e2e-on-feature-review hook's job, so no agent may do it by hand.
    describe("e2e is blocked for every caller", () => {
      const e2eCases = [
        ["orchestrator", "npx playwright test"],
        [
          "orchestrator",
          "E2E_SMOKE_SRC=/tmp/wt/_session bash .claude/scripts/e2e-smoke.sh",
        ],
        ["merger", "make test-e2e"],
        ["", "make test-e2e-ci"],
        // Bringing the stack UP is worse than running the suite: observed on a real
        // migration, `make start-e2e` never returns (it backgrounds a dev server that
        // holds the pipe open), rm -rf's the e2e database out from under a human, and
        // starts the shared stack the slot-leased isolated one exists to replace.
        ["developer", "make start-e2e"],
        ["orchestrator", "make start-supabase-e2e"],
        ["", "make stop-e2e"],
        ["", "make start-e2e 2>&1 | tail -30"],
      ];

      test.each(e2eCases)("%s running '%s' → blocked", (agent, command) => {
        const r = runHook(agent, command);
        expect(r.status).toBe(0);
        expect(isBlocked(r)).toBe(true);
      });

      // The token match must not swallow unrelated make targets.
      test.each(["make lint", "make build", "make install", "make typecheck"])(
        "'%s' is not caught by the e2e token match",
        (command) => {
          expect(isBlocked(runHook("merger", command))).toBe(false);
        },
      );

      test("dropping e2e from the config unblocks it again", () => {
        const noE2e = {
          validation: {
            steps: [
              {
                id: "typecheck",
                kind: "typecheck",
                command: "npm run typecheck",
              },
            ],
            extraForbidden: [],
          },
          roles: { developer: { model: "sonnet" } },
        };
        const r = runHookWithConfig(
          "orchestrator",
          "npx playwright test",
          noE2e,
        );
        expect(isBlocked(r)).toBe(false);
      });
    });

    test("main session running validation command → allowed", () => {
      const r = runHook("", "npx vitest run");
      expect(isBlocked(r)).toBe(false);
    });

    test("gated agent running plain git command → allowed", () => {
      const r = runHook("developer", "git status && git log --oneline -3");
      expect(isBlocked(r)).toBe(false);
    });

    test("empty command → allowed", () => {
      const r = runHook("developer", "");
      expect(isBlocked(r)).toBe(false);
    });
  });

  describe("forbidden set is config-driven (no triple-encoding)", () => {
    // A config with only a typecheck step and no extraForbidden: typecheck stays
    // guarded, but unit/e2e/build are no longer part of the chain, so the guard
    // must NOT block them.
    const typecheckOnly = {
      validation: {
        steps: [
          { id: "typecheck", kind: "typecheck", command: "npm run typecheck" },
        ],
        extraForbidden: [],
      },
      roles: { developer: { model: "sonnet" } },
    };

    test("a kind present in config is still blocked", () => {
      const r = runHookWithConfig(
        "developer",
        "npm run typecheck",
        typecheckOnly,
      );
      expect(isBlocked(r)).toBe(true);
    });

    test("a kind absent from config is NOT blocked", () => {
      const r = runHookWithConfig("developer", "npx vitest run", typecheckOnly);
      expect(isBlocked(r)).toBe(false);
    });

    test("removing lint from extraForbidden stops blocking lint", () => {
      const r = runHookWithConfig("developer", "npm run lint", typecheckOnly);
      expect(isBlocked(r)).toBe(false);
    });

    test("a lint step in the chain blocks manual lint (no extraForbidden)", () => {
      const withLintStep = {
        validation: {
          steps: [
            {
              id: "lint",
              kind: "lint",
              command: "npx eslint",
              changedScoped: true,
            },
          ],
          extraForbidden: [],
        },
        roles: { developer: { model: "sonnet" } },
      };
      const r = runHookWithConfig("developer", "npm run lint", withLintStep);
      expect(isBlocked(r)).toBe(true);
    });

    test("extraForbidden build is blocked when listed", () => {
      const withBuild = {
        validation: { steps: [], extraForbidden: ["build"] },
        roles: { developer: { model: "sonnet" } },
      };
      const r = runHookWithConfig("developer", "npm run build", withBuild);
      expect(isBlocked(r)).toBe(true);
    });
  });

  describe("guard-state rule — orchestrator only", () => {
    // The give-up marker is what keeps a red ticket out of the base branch, so the enforced
    // party must not be able to lift its own refusal. Recovery is a green validation run.
    test("the orchestrator cannot delete a validation-gave-up marker", () => {
      const r = runHook(
        "orchestrator",
        "rm -f /tmp/_repo/sess-1234/validation-gave-up/TASK-001",
      );
      expect(isBlocked(r)).toBe(true);
    });

    const SD = "/tmp/_repo/sess-1234";

    // This block fires exactly when the orchestrator is stuck at the merger gate, so its
    // text is the recovery procedure. It used to say the reviewer writes its own flag and
    // that a missing flag means the reviewer did not approve. Both stopped being true when
    // the self-write became an opt-in fallback: the flag is the record-review-verdict
    // hook's, and a missing flag means no APPROVED line was READ, which is the case the
    // orchestrator must diagnose from hooks.log instead of re-reviewing or forging it.
    describe("the recovery guidance names the real writer", () => {
      const guidance = () =>
        runHook("orchestrator", `touch ${SD}/reviews/TASK-002-quality-reviewer`)
          .stdout;

      test("it points at the hook and at hooks.log", () => {
        const out = guidance();
        expect(out).toContain("record-review-verdict");
        expect(out).toContain("hooks.log");
        expect(out).toContain("contract line");
      });

      test("it does not claim the reviewer writes the flag, nor that a missing flag is a rejection", () => {
        const out = guidance();
        expect(out).not.toMatch(/reviewer writes its own flag/);
        expect(out).not.toMatch(/did NOT approve/);
      });
    });

    test("orchestrator touches a review flag → blocked", () => {
      const r = runHook(
        "orchestrator",
        `touch ${SD}/reviews/TASK-002-quality-reviewer`,
      );
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(true);
    });

    test("orchestrator rm's a breaker marker → blocked", () => {
      const r = runHook("orchestrator", `rm ${SD}/breaker/dispatch-abc123`);
      expect(isBlocked(r)).toBe(true);
    });

    test("orchestrator mkdir + touch a review flag (compound) → blocked", () => {
      const r = runHook(
        "orchestrator",
        `mkdir -p ${SD}/reviews && touch ${SD}/reviews/TASK-002-quality-reviewer`,
      );
      expect(isBlocked(r)).toBe(true);
    });

    test("orchestrator redirects into a breaker file → blocked", () => {
      const r = runHook("orchestrator", `echo x > ${SD}/breaker/marker`);
      expect(isBlocked(r)).toBe(true);
    });

    test("orchestrator lists the reviews dir (read) → allowed", () => {
      const r = runHook("orchestrator", `ls ${SD}/reviews/`);
      expect(isBlocked(r)).toBe(false);
    });

    test("orchestrator cats a review flag with 2>/dev/null (read) → allowed", () => {
      const r = runHook(
        "orchestrator",
        `cat ${SD}/reviews/TASK-002-quality-reviewer 2>/dev/null`,
      );
      expect(isBlocked(r)).toBe(false);
    });

    test("quality-reviewer touches its own flag → allowed (reviewer is the writer)", () => {
      const r = runHook(
        "quality-reviewer",
        `mkdir -p ${SD}/reviews && touch ${SD}/reviews/TASK-002-quality-reviewer`,
      );
      expect(isBlocked(r)).toBe(false);
    });

    test("orchestrator rm of an unrelated tmp file → allowed", () => {
      const r = runHook("orchestrator", `rm ${SD}/scratch/note.txt`);
      expect(isBlocked(r)).toBe(false);
    });

    test("chat-orchestrator variant touching a review flag → blocked", () => {
      const r = runHook(
        "chat-orchestrator",
        `touch ${SD}/reviews/TASK-001-quality-reviewer`,
      );
      expect(isBlocked(r)).toBe(true);
    });

    // Regression: the form the codebase teaches the reviewer uses a shell
    // variable, so the literal command text is `…/reviews"` then `$RD/…` and
    // never contains `/reviews/`. The trailing-slash-only guard missed it,
    // letting a confused orchestrator forge a verdict flag through the
    // documented form.
    test("orchestrator forging the flag via the documented variable form → blocked", () => {
      const r = runHook(
        "orchestrator",
        `RD="$(dirname "$TICKET_FILE")/reviews" && mkdir -p "$RD" && touch "$RD/TASK-002-quality-reviewer"`,
      );
      expect(isBlocked(r)).toBe(true);
    });

    test("orchestrator cd-ing into the reviews dir then touching a flag → blocked", () => {
      const r = runHook(
        "orchestrator",
        `cd ${SD}/reviews && touch TASK-002-quality-reviewer`,
      );
      expect(isBlocked(r)).toBe(true);
    });
  });

  // A quoted pattern is data. The rule matched inside it, so looking FOR a forbidden
  // command was refused as running one.
  describe("validation rules: a search pattern is not an invocation", () => {
    test.each([
      ["grep", `grep -rn "npm run typecheck" src/`],
      ["rg", `rg 'make lint' --type ts`],
      ["grep with a pipe after it", `grep -rn "npx vitest" . | head -5`],
    ])("%s for a forbidden command → allowed", (_label, command) => {
      const r = runHook("developer", command);
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(false);
    });

    // The masking is confined to the search segment: a real invocation in quotes, and a
    // real invocation piped into a grep, are still what they are.
    test.each([
      ["bash -c", `bash -c "npm run typecheck"`],
      ["piped into grep", `npm run typecheck | grep error`],
    ])("%s → still blocked", (_label, command) => {
      expect(isBlocked(runHook("developer", command))).toBe(true);
    });
  });

  // A refusal an agent cannot comply with is a refusal it retries in another
  // phrasing. The two causes hiding behind `>` need two different exits: an
  // editing agent is sent to the Write tool, an agent capturing a process's
  // output is told which sinks it may use.
  describe("file-write rules: guidance per cause", () => {
    const SCRATCHPAD = `/tmp/claude-1000/-workspaces-app/${SESSION_ID}/scratchpad`;
    const WRITE_TOOL = "Use the Write or Edit tool instead";
    const OUTPUT_SINKS = "Capturing process output to a file via Bash is gated";

    test("redirect to a source file → the file-edit message", () => {
      const r = runHook("developer", "echo 'export const x = 1' > src/x.ts");
      expect(isBlocked(r)).toBe(true);
      expect(r.stdout).toContain(WRITE_TOOL);
      expect(r.stdout).not.toContain(OUTPUT_SINKS);
    });

    test.each([
      ["sed -i", "sed -i 's/a/b/' src/x.ts"],
      ["awk -i inplace", "awk -i inplace '{print}' src/x.ts"],
      ["scripted write", `node -e "require('fs').writeFileSync('a.ts','x')"`],
    ])("%s → the file-edit message", (_label, command) => {
      const r = runHook("developer", command);
      expect(isBlocked(r)).toBe(true);
      expect(r.stdout).toContain(WRITE_TOOL);
    });

    test("redirecting a dev server's log names the allowed forms", () => {
      const r = runHook(
        "developer",
        "npm run dev:demo > /tmp/dev-5300.log 2>&1",
      );
      expect(isBlocked(r)).toBe(true);
      expect(r.stdout).toContain(OUTPUT_SINKS);
      // The whole point: the exits are named, not left to be guessed.
      expect(r.stdout).toContain("> /dev/null 2>&1");
      expect(r.stdout).toContain("run_in_background: true");
      expect(r.stdout).not.toContain(WRITE_TOOL);
    });

    test("the developer is told the scratchpad sink is the reviewer's", () => {
      const r = runHook("developer", "npm run dev:demo > /tmp/dev.log 2>&1");
      expect(r.stdout).toContain("allowed for the quality-reviewer only");
    });

    // The reviewer is the role that RUNS the app to verify it, so its log
    // capture is sanctioned, but only into this session's scratchpad.
    test("reviewer redirecting into the session scratchpad → allowed", () => {
      const r = runHook(
        "quality-reviewer",
        `cd /wt/TASK-003 && npm run dev:demo -- --port 5303 > ${SCRATCHPAD}/demo-5303.log 2>&1 &`,
      );
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(false);
    });

    test("developer redirecting into the same scratchpad → still blocked", () => {
      const r = runHook(
        "developer",
        `cd /wt/TASK-003 && npm run dev:demo -- --port 5303 > ${SCRATCHPAD}/demo-5303.log 2>&1 &`,
      );
      expect(isBlocked(r)).toBe(true);
    });

    // The exemption is the scratchpad, not the reviewer: a reviewer writing
    // anywhere else is refused exactly as before.
    test("reviewer redirecting outside the scratchpad → blocked", () => {
      const r = runHook("quality-reviewer", "npm run dev:demo > /tmp/demo.log");
      expect(isBlocked(r)).toBe(true);
    });

    // sed/awk in-place reported an EMPTY target, so the scratchpad exemption above was
    // never even consulted for them: a reviewer editing its own scratchpad file was
    // refused three times in one run, for a file no guard is meant to protect.
    test("reviewer editing its own scratchpad in place → allowed", () => {
      const r = runHook(
        "quality-reviewer",
        `sed -i 's/PASS/FAIL/' ${SCRATCHPAD}/flows.md`,
      );
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(false);
    });

    test("reviewer editing a source file in place → still blocked", () => {
      const r = runHook("quality-reviewer", "sed -i 's/a/b/' src/x.ts");
      expect(isBlocked(r)).toBe(true);
    });

    // The exemption covers the command it is in, not the command next to it.
    test("a scratchpad edit chained with a source edit → blocked", () => {
      const r = runHook(
        "quality-reviewer",
        `sed -i 's/a/b/' ${SCRATCHPAD}/notes.md && sed -i 's/a/b/' src/x.ts`,
      );
      expect(isBlocked(r)).toBe(true);
    });

    test("another session's scratchpad is not this session's → blocked", () => {
      const r = runHook(
        "quality-reviewer",
        "npm run dev:demo > /tmp/claude-1000/-workspaces-app/other-session/scratchpad/demo.log 2>&1",
      );
      expect(isBlocked(r)).toBe(true);
    });

    // `=>` is a JavaScript arrow, never a shell redirect. Reading it as one
    // refused every `node -e` one-liner that passes a callback, which is how an
    // agent drives a headless browser from Bash.
    test.each([
      `node -e "j(rows, {}, (e, csv) => console.log(csv))"`,
      `npx tsx -e "p.on('console', (m) => errs.push(m.text()))"`,
    ])("an arrow function is not a redirect: %s", (command) => {
      const r = runHook("quality-reviewer", command);
      expect(r.status).toBe(0);
      expect(isBlocked(r)).toBe(false);
    });

    test("2>/dev/null alone → allowed", () => {
      expect(isBlocked(runHook("developer", "ls /nope 2>/dev/null"))).toBe(
        false,
      );
    });

    // Regression: a real write must not be waved through because an unrelated
    // /dev/null redirect appears in the same command.
    test("a /dev/null redirect does not disarm a real write", () => {
      const r = runHook("developer", "grep -r x . 2>/dev/null > out.ts");
      expect(isBlocked(r)).toBe(true);
    });

    test("pipe to tee a file → blocked", () => {
      expect(isBlocked(runHook("developer", "echo x | tee src/x.ts"))).toBe(
        true,
      );
    });

    test("tee to /dev/null → allowed", () => {
      expect(isBlocked(runHook("developer", "echo x | tee /dev/null"))).toBe(
        false,
      );
    });

    test("a plain read command with no redirect → allowed", () => {
      expect(isBlocked(runHook("developer", "cat src/x.ts"))).toBe(false);
    });
  });

  // A block is only judgeable after the fact if the log says WHICH rule fired:
  // the agent-facing message names it, the log used to record only the family.
  describe("every block records its rule in the log line", () => {
    const logFor = (agent, command) => {
      runHook(agent, command);
      const log = join(
        tmpRoot,
        standardRepo.replace(/\//g, "_"),
        SESSION_ID,
        "hooks.log",
      );
      return readFileSync(log, "utf8");
    };

    test.each([
      ["", "npx playwright test --headed", "rule=headed-playwright"],
      ["", "npm run dev -- --open", "rule=vite-open"],
      ["developer", "npm run typecheck", "rule=typecheck"],
      ["developer", "npx vitest run", "rule=unit"],
      ["", "make test-e2e", "rule=e2e"],
      ["orchestrator", "touch /tmp/s/reviews/f", "rule=guard-state-mutation"],
      ["developer", "echo x > src/x.ts", "rule=redirect kind=file-edit"],
      [
        "developer",
        "npm run dev > /tmp/d.log 2>&1",
        "rule=redirect kind=process-output",
      ],
      ["developer", "sed -i 's/a/b/' src/x.ts", "rule=sed-in-place"],
    ])("%s running '%s' logs %s", (agent, command, label) => {
      expect(logFor(agent, command)).toContain(label);
    });
  });
});
