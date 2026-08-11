// Tests for lib/bash-classify.mjs: which Bash calls count against the work budget.
//
// Misclassifying a read-only command as work is what makes the circuit breaker fire on a
// healthy agent. Real commands rarely start with their verb: they start with a `cd` into a
// worktree, an env assignment, a subshell or a loop header, and only stripping
// `cd <path> &&` counted a read-only audit shell as work.
//
// The opposite error matters just as much: if a writer slips through as free, the breaker
// cannot see the loop it exists to catch.

import { describe, expect, test } from "vitest";
import { isFreeCommand, stripPrefixes } from "../lib/bash-classify.mjs";

describe("free: read-only exploration, whatever precedes it", () => {
  test.each([
    ["grep -rn Foo src", "bare"],
    ["cd /tmp/wt && grep -rn Foo src", "cd prefix"],
    ['cd "/tmp/my wt" && grep -rn Foo src', "quoted cd"],
    ["L=x; grep -rn $L src", "env assignment then the command"],
    ["FOO=bar grep -rn Foo src", "env assignment as a command prefix"],
    ["A=1 B=2 grep -rn Foo src", "several assignments"],
    ["( cd /tmp/wt && grep -rn Foo src )", "subshell"],
    ["{ grep -rn Foo src; }", "brace group"],
    ["for f in *.ts; do grep -n Foo $f; done", "for loop"],
    ["while read l; do echo $l; done", "while loop"],
    ["time grep -rn Foo src", "time prefix"],
    ["cd /wt && L=x; ( grep -rn Foo src )", "combined prefixes"],
  ])("%j is free (%s)", (cmd) => {
    expect(isFreeCommand(cmd)).toBe(true);
  });

  test.each([
    "grep -rn Foo src | awk '{print $1}' | sort | uniq -c | head -20",
    "cat log | grep ERROR | wc -l",
    "L=x; grep -rn $L src | awk -F: '{print $1}' | sort -u",
  ])("a read-only pipeline is free: %j", (cmd) => {
    expect(isFreeCommand(cmd)).toBe(true);
  });

  test.each([
    "git status --porcelain",
    "git -C /tmp/wt diff --stat",
    'cd /wt && git commit -m "feat(TASK-001): x"',
    "git for-each-ref --format='%(refname:short)' refs/heads/ab12",
  ])("git plumbing and commit are free: %j", (cmd) => {
    expect(isFreeCommand(cmd)).toBe(true);
  });

  // The technical persona REQUIRES an append per step, so counting them spends the budget
  // on the bookkeeping the harness itself asked for.
  test.each([
    'echo "[wave] done" >> /tmp/s/harness-progress.log',
    'cd /wt && printf "x\\n" >> "$SESSION_DIR/harness-progress.log"',
    "echo done >>/tmp/s/harness-progress.log",
  ])("a progress-log append is free: %j", (cmd) => {
    expect(isFreeCommand(cmd)).toBe(true);
  });
});

describe("work: anything that actually does something", () => {
  test.each([
    ["node work.mjs", "a script"],
    ["cd /tmp/wt && node work.mjs", "a script behind cd"],
    ["npm run build", "a build"],
    ["npx vitest run", "a test run"],
    ["rm -rf dist", "a delete"],
    ["mv a b", "a move"],
    ["sed -i s/a/b/ f.ts", "an in-place edit"],
    ["git push", "a git command that is not plumbing"],
    ["git rebase session/ab12", "a rebase"],
    ["docker compose up", "a container"],
  ])("%j is work (%s)", (cmd) => {
    expect(isFreeCommand(cmd)).toBe(false);
  });

  // Only the first stage used to be inspected, so a pipeline that ENDS in work read as
  // exploration.
  test("a pipeline whose later stage does work is work", () => {
    expect(isFreeCommand("grep -rn Foo src | node transform.mjs")).toBe(false);
    expect(isFreeCommand("cat list.txt | xargs rm")).toBe(false);
  });

  test("a free command chained to a work command is work", () => {
    expect(isFreeCommand("grep -rn Foo src && node build.mjs")).toBe(false);
    expect(isFreeCommand("git status; npm run build")).toBe(false);
  });

  // A redirect makes a reader a writer. The progress log is the one exception, checked
  // before this.
  test("a read-only verb redirected into a file is work", () => {
    expect(isFreeCommand("grep -rn Foo src > found.txt")).toBe(false);
    expect(isFreeCommand("cat a.ts >> b.ts")).toBe(false);
  });

  test("stderr redirection is not a file write", () => {
    expect(isFreeCommand("grep -rn Foo src 2>&1")).toBe(true);
  });
});

// Shell punctuation inside a quoted argument is data, not structure. Reading it as
// structure counted three ordinary exploration shapes as work, and over-counting is what
// makes the breaker fire on an agent whose only sin is reading a lot of code.
describe("free: punctuation that only looks like structure", () => {
  test.each([
    [
      "grep -rn foo src/ 2>/dev/null",
      "the discard idiom, on the commonest reader",
    ],
    ["find . -name '*.ts' 2>/dev/null | head -20", "discard inside a pipeline"],
    ["cat missing.txt 2>/dev/null", "discard on a read"],
    ["ls -la /wt >/dev/null", "discard of stdout"],
    ["grep -rn Foo src 2>err.log", "stderr captured, nothing else written"],
    ['echo "a -> b"', "an arrow inside a string"],
    ['grep "a;b" file', "a command separator inside a string"],
    ["grep 'x && y' file", "an and-list inside a string"],
    ['grep "a|b" file', "a pipe inside a string"],
    ['cd /wt && grep -rn "a;b" src 2>/dev/null', "all of it at once"],
  ])("%j is free (%s)", (cmd) => {
    expect(isFreeCommand(cmd)).toBe(true);
  });

  // The quoting fix must not hide a real writer behind a quote or a discard.
  test.each([
    ["node build.mjs 2>/dev/null", "a script whose stderr is discarded"],
    ["npm run build > log.txt 2>&1", "a build whose output is captured"],
    ['echo "done" > out.txt', "a quoted string redirected into a file"],
    ['grep -rn "a;b" src && node build.mjs', "work after a quoted separator"],
    ['cat "a b.ts" >> out.ts', "an append with a quoted path"],
  ])("%j is still work (%s)", (cmd) => {
    expect(isFreeCommand(cmd)).toBe(false);
  });
});

describe("stripPrefixes", () => {
  test.each([
    ["cd /tmp/wt && grep x", "grep x"],
    ["FOO=bar grep x", "grep x"],
    ["( grep x", "grep x"],
    ["for f in a b; do grep x", "grep x"],
  ])("%j -> %j", (input, expected) => {
    expect(stripPrefixes(input)).toBe(expected);
  });

  test("terminates on input that is nothing but prefixes", () => {
    expect(stripPrefixes("cd /a && cd /b && ")).toBe("");
    expect(isFreeCommand("cd /a && cd /b && ")).toBe(true);
  });

  test("empty and nullish input never crash", () => {
    expect(isFreeCommand("")).toBe(true);
    expect(isFreeCommand(undefined)).toBe(true);
    expect(isFreeCommand(null)).toBe(true);
  });
});

describe("the plugin's symbol lookup is free", () => {
  // It is the sanctioned replacement for a grep that costs the same, on a pipeline where
  // the LSP tool is unreachable. Charging it against the work budget would make the
  // cheaper, less correct tool the free one.
  test("node ts-symbols.mjs is free, with or without a cd prefix", () => {
    expect(
      isFreeCommand(
        'node "${CLAUDE_PLUGIN_ROOT}/scripts/ts-symbols.mjs" refs src/a.tsx 28 17',
      ),
    ).toBe(true);
    expect(
      isFreeCommand("cd /tmp/wt && node /p/scripts/ts-symbols.mjs sym Foo"),
    ).toBe(true);
  });

  test("any other node script is still work", () => {
    expect(isFreeCommand("node scripts/build.mjs")).toBe(false);
  });

  test("redirecting its output into a file makes it work again", () => {
    expect(
      isFreeCommand("node /p/scripts/ts-symbols.mjs sym Foo > out.txt"),
    ).toBe(false);
  });
});
