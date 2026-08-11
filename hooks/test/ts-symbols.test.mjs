// Tests for scripts/ts-symbols.mjs: the symbol lookup that stands in for the LSP tool.
//
// It exists because every harness agent runs in the background and a background subagent
// has LSP pruned from its set, which no prompt and no plugin manifest can change. So this
// script is the ONLY semantic answer those three roles can reach, and the properties that
// matter are the ones that decide whether an agent trusts it: real answers resolved
// through the type system, and failures that say what to do instead of printing nothing.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "..", "scripts", "ts-symbols.mjs");

// The script drives the PROJECT's TypeScript, so the fixture needs one. This repo does not
// depend on typescript (it ships hooks, not a compiled app), and CI installs devDeps only,
// so these run wherever a typescript is reachable and skip, saying why, where it is not.
// Skipping is the honest outcome: a stub compiler would test the stub.
const TS = join(HERE, "..", "..", "node_modules", "typescript");
const describeWithTs = existsSync(TS) ? describe : describe.skip.bind(null);

// A throwaway project: two files, a real import, and the repo's own typescript borrowed
// through a symlink so the script resolves the same compiler the project would.
let project;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "ts-symbols-"));
  mkdirSync(join(project, "src"), { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "p" }));
  writeFileSync(
    join(project, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: { target: "ES2020", module: "ESNext", strict: true },
      include: ["src"],
    }),
  );
  writeFileSync(
    join(project, "src", "hook.ts"),
    "export function useThing() {\n  return 1;\n}\n",
  );
  writeFileSync(
    join(project, "src", "caller.ts"),
    'import { useThing } from "./hook";\n\nexport const n = useThing();\n',
  );
  mkdirSync(join(project, "node_modules"), { recursive: true });
  symlinkSync(TS, join(project, "node_modules", "typescript"), "dir");
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

const run = (...args) => {
  try {
    return {
      ok: true,
      out: execFileSync("node", [SCRIPT, ...args], {
        cwd: project,
        encoding: "utf8",
      }).trim(),
    };
  } catch (e) {
    return { ok: false, out: String(e.stderr || e.stdout || "").trim() };
  }
};

describeWithTs("ts-symbols (needs a resolvable typescript)", () => {
  test("sym locates a symbol by name, with a 1-based position", () => {
    const r = run("sym", "useThing");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("src/hook.ts:1:");
    expect(r.out).toContain("useThing");
  });

  test("refs finds the declaration AND the use in another file", () => {
    const r = run("refs", "src/hook.ts", "1", "17");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("(definition)");
    // The import and the call site both live in caller.ts: this is the answer grep cannot
    // give, because it cannot tell these from a same-named symbol elsewhere.
    expect(r.out).toContain("src/caller.ts:1:");
    expect(r.out).toContain("src/caller.ts:3:");
  });

  test("def jumps from a use back to the declaration", () => {
    const r = run("def", "src/caller.ts", "3", "20");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("src/hook.ts:1:");
  });

  test("an empty result says so rather than printing nothing", () => {
    // A blank stdout reads as a broken command and sends the caller back to grep.
    const r = run("sym", "NoSuchSymbolAnywhere");
    expect(r.ok).toBe(true);
    expect(r.out).toContain("no sym result");
  });

  test("a file outside the program names the config that excluded it", () => {
    const r = run("refs", "src/absent.ts", "1", "1");
    expect(r.ok).toBe(false);
    expect(r.out).toContain("not part of the TypeScript program");
    expect(r.out).toContain("tsconfig.json");
  });

  test("no command prints the usage", () => {
    expect(run().out).toContain("usage:");
  });

  test("run from outside a project, it says where to run it instead", () => {
    let out = "";
    try {
      execFileSync("node", [SCRIPT, "sym", "X"], {
        cwd: tmpdir(),
        encoding: "utf8",
      });
    } catch (e) {
      out = String(e.stderr || "");
    }
    expect(out).toContain("typescript");
    expect(out).toContain("worktree");
  });
});
