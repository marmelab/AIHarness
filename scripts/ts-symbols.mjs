#!/usr/bin/env node
// Symbol questions answered through the TypeScript program, from Bash.
//
// The `LSP` tool is unreachable from a harness agent: every one of them is dispatched by
// the orchestrator, which is itself a subagent and is not given `run_in_background` to
// set, so they all run in the background — and a background subagent has the LSP tool
// pruned from its set. That is a runtime bug with four open reports and no fix
// (anthropics/claude-code#76090, #80733, #84125, #85310); the one workaround those reports
// confirm, a foreground dispatch, is exactly the thing a nested subagent cannot ask for.
//
// Bash is reachable from every agent, on every surface, foreground or background. So the
// same questions are answered here, through the project's own TypeScript program, with no
// new dependency: `typescript` is already what the project typechecks with.
//
// NOT a general grep replacement. A call costs about as much as the grep it replaces, so
// the reason to use it is correctness, not speed: text search cannot tell a definition
// from a comment, misses re-exports and aliased imports, and answers for every same-named
// symbol at once. Worth it for "who calls this, and did I miss one", wasted on "which
// files mention this word".
//
// Usage, from inside the worktree (paths are printed relative to it):
//   node <plugin>/scripts/ts-symbols.mjs sym  <name>                locate a symbol
//   node <plugin>/scripts/ts-symbols.mjs def  <file> <line> <col>   where it is declared
//   node <plugin>/scripts/ts-symbols.mjs refs <file> <line> <col>   every real use
//
// Positions are 1-based, as shown by `Read` and by every editor. Delete this script the
// day the runtime hands subagents their LSP tool: nothing else depends on it.

import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const [, , cmd, ...rest] = process.argv;
const root = process.cwd();

const die = (msg, code = 2) => {
  console.error(`ts-symbols: ${msg}`);
  process.exit(code);
};

// The project's TypeScript, not one of ours: the answers have to match what the project
// actually compiles with, and the plugin ships no node_modules of its own.
let ts;
try {
  ts = createRequire(join(root, "package.json"))("typescript");
} catch {
  die(
    `no \`typescript\` resolvable from ${root}. Run this from inside the worktree, ` +
      `where the project's node_modules is.`,
  );
}

const cfgPath =
  ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.app.json") ||
  ts.findConfigFile(root, ts.sys.fileExists, "tsconfig.json");
if (!cfgPath) die(`no tsconfig found from ${root}`);

const cfg = ts.parseJsonConfigFileContent(
  ts.readConfigFile(cfgPath, ts.sys.readFile).config,
  ts.sys,
  resolve(cfgPath, ".."),
);

// A language service rather than a plain program: findReferences and navigate-to are
// service operations, and the service is what an editor (and the LSP server) runs too, so
// the answers are the same ones LSP would have given.
const versions = new Map(cfg.fileNames.map((f) => [f, "1"]));
const service = ts.createLanguageService(
  {
    getScriptFileNames: () => [...versions.keys()],
    getScriptVersion: (f) => versions.get(f) ?? "1",
    getScriptSnapshot: (f) => {
      const text = ts.sys.readFile(f);
      return text === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => root,
    getCompilationSettings: () => cfg.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  },
  ts.createDocumentRegistry(),
);

const rel = (f) => (f.startsWith(root + "/") ? f.slice(root.length + 1) : f);

const at = (file, pos) => {
  const src = service.getProgram().getSourceFile(file);
  if (!src) return "?:?";
  const lc = ts.getLineAndCharacterOfPosition(src, pos);
  return `${lc.line + 1}:${lc.character + 1}`;
};

const offsetOf = (file, line, col) => {
  const src = service.getProgram().getSourceFile(file);
  if (!src)
    die(
      `${rel(file)} is not part of the TypeScript program (check the path, and that it is not excluded by ${rel(cfgPath)})`,
    );
  return ts.getPositionOfLineAndCharacter(src, line - 1, col - 1);
};

const position = () => {
  const [file, line, col] = rest;
  if (!file || !line || !col) die(`${cmd} needs <file> <line> <col>`);
  const abs = resolve(root, file);
  return [abs, offsetOf(abs, Number(line), Number(col))];
};

const lines = [];
if (cmd === "sym") {
  if (!rest[0]) die("sym needs a symbol name");
  for (const hit of service.getNavigateToItems(rest[0], 40))
    lines.push(
      `${rel(hit.fileName)}:${at(hit.fileName, hit.textSpan.start)}  ${hit.name} (${hit.kind})`,
    );
} else if (cmd === "def") {
  const [file, pos] = position();
  for (const d of service.getDefinitionAtPosition(file, pos) ?? [])
    lines.push(
      `${rel(d.fileName)}:${at(d.fileName, d.textSpan.start)}  ${d.name} (${d.kind})`,
    );
} else if (cmd === "refs") {
  const [file, pos] = position();
  for (const group of service.findReferences(file, pos) ?? [])
    for (const r of group.references)
      lines.push(
        `${rel(r.fileName)}:${at(r.fileName, r.textSpan.start)}${r.isDefinition ? "  (definition)" : ""}`,
      );
} else {
  die(
    "usage: ts-symbols.mjs sym <name> | def <file> <line> <col> | refs <file> <line> <col>",
  );
}

// An empty result is a real answer (nothing references this), and saying so beats silence:
// a blank stdout reads as a broken command and sends the caller back to grep.
console.log(lines.length ? lines.join("\n") : `ts-symbols: no ${cmd} result`);
