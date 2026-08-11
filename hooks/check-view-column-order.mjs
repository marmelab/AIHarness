#!/usr/bin/env node
// PostToolUse(Write|Edit): a new column in a `CREATE OR REPLACE VIEW` must be APPENDED.
//
// PostgreSQL refuses to replace a view whose existing columns move, are renamed or change
// type (error 42P16): a replacement may only ADD columns, at the end. Insert a column in
// the middle of the select list and everything typechecks, every test passes, and the
// DEPLOY fails — the one place where nothing local can catch it.
//
// Three consecutive feature runs made this exact mistake on the first schema ticket, each
// time inserting the new column next to a semantically related one, which is what a
// careful developer naturally does. Each was caught by review and cost a full retry round.
// The instruction in the developer prompt did not prevent any of the three, so it is not
// an instruction problem: the mistake is invisible at the moment it is made, and the
// feedback arrived minutes later from another agent.
//
// So it is checked here, against the file's own git HEAD, at the moment of the edit.
// Non-blocking (exit 1), like the other PostToolUse checks: the developer is told
// immediately, in the turn that made the change, and stays free to justify a deliberate
// full rebuild (a DROP + CREATE migration is a legitimate, if heavier, answer).

import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { createHookContext } from "./lib/context.mjs";

let input = {};
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  process.exit(0); // unparseable payload: nothing to check, fail open
}

const filePath = input.tool_input?.file_path || "";
// Views live in the declarative schema. A migration file is exempt: it is allowed to
// DROP and recreate, which is the sanctioned way to reorder.
if (!/\.sql$/.test(filePath) || /\/migrations\//.test(filePath))
  process.exit(0);

const readFile = (p) => {
  try {
    return readFileSync(p, "utf8");
  } catch {
    return null;
  }
};

const after = readFile(filePath);
if (!after || !/create\s+or\s+replace\s+view/i.test(after)) process.exit(0);

// The committed version of the same file. No HEAD copy (a brand-new file, or not a repo)
// means there is no previous column order to preserve.
const head = spawnSync(
  "git",
  ["show", `HEAD:./${filePath.split("/").slice(-1)[0]}`],
  { cwd: dirname(filePath), encoding: "utf8" },
);
const before =
  head.status === 0
    ? head.stdout
    : spawnSync("git", ["show", `HEAD:${filePath}`], {
        encoding: "utf8",
        cwd: dirname(filePath),
      }).stdout;
if (!before || !before.trim()) process.exit(0);

/**
 * The output column names of each `create or replace view`, in select-list order.
 *
 * Names only, and only the ones a replacement must keep in place: an explicit alias, else
 * the trailing identifier of a `table.column` reference. An expression with no alias
 * cannot be tracked by name, so it is skipped rather than guessed at — a false alarm here
 * would train the developer to ignore the check, which is worse than a miss.
 *
 * @param {string} sql
 * @returns {Map<string, string[]>}  view name -> ordered column names
 */
const viewColumns = (sql) => {
  const views = new Map();
  const RE =
    /create\s+or\s+replace\s+view\s+([\w."]+)[\s\S]*?\bas\b([\s\S]*?)(?=;\s*(?:\n|$))/gi;
  for (const m of sql.matchAll(RE)) {
    const name = m[1].replace(/"/g, "").toLowerCase();
    const body = m[2];
    const from = body.search(/\bfrom\b/i);
    const selectList = (from === -1 ? body : body.slice(0, from)).replace(
      /^\s*select\s+/i,
      "",
    );
    // Split on commas that are not inside parentheses: aggregate calls hold their own.
    const cols = [];
    let depth = 0;
    let cur = "";
    for (const ch of selectList) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        cols.push(cur);
        cur = "";
      } else cur += ch;
    }
    cols.push(cur);
    const named = cols
      .map((c) => {
        const t = c.trim();
        if (!t) return "";
        const alias = t.match(/\bas\s+"?([\w]+)"?\s*$/i);
        if (alias) return alias[1].toLowerCase();
        const plain = t.match(/^[\w."]+$/) && t.split(".").pop();
        return plain ? plain.replace(/"/g, "").toLowerCase() : "";
      })
      .filter(Boolean);
    if (named.length) views.set(name, named);
  }
  return views;
};

const oldViews = viewColumns(before);
const newViews = viewColumns(after);

const problems = [];
for (const [view, nowCols] of newViews) {
  const wasCols = oldViews.get(view);
  if (!wasCols) continue; // new view: any order is fine
  const added = nowCols.filter((c) => !wasCols.includes(c));
  if (!added.length) continue;
  // Every column that already existed must keep its position, which means the additions
  // are exactly the tail. Compare the surviving prefix against the old order.
  const kept = nowCols.filter((c) => wasCols.includes(c));
  const stillInOrder =
    kept.length === wasCols.length && kept.every((c, i) => c === wasCols[i]);
  const appendedLast = nowCols
    .slice(kept.length)
    .every((c) => added.includes(c));
  if (!stillInOrder || !appendedLast)
    problems.push({ view, added, expected: [...wasCols, ...added] });
}

if (!problems.length) process.exit(0);

const ctx = createHookContext(input, "check-view-column-order");
ctx.log(
  `FLAG ${filePath} ${problems.map((p) => `${p.view}(+${p.added.join(",")})`).join(" ")}`,
);
ctx.error(
  problems
    .map(
      (p) =>
        `${filePath}: \`${p.view}\` adds ${p.added.map((c) => `\`${c}\``).join(", ")} ` +
        `without keeping the existing columns in place.\n` +
        `CREATE OR REPLACE VIEW cannot move, rename or retype an existing column ` +
        `(PostgreSQL 42P16), so the deploy-time migration will fail even though every ` +
        `local check passes.\n` +
        `Move the new column(s) to the END of the select list: ${p.expected.join(", ")}.`,
    )
    .join("\n\n"),
);
process.exit(1);
