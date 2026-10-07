#!/usr/bin/env node
// Lot 0: the same task on two arms, side by side.
//
//   node scripts/run-archive.mjs
//   node scripts/run-ingest.mjs --session <id> --arm A --label "contact filter, harness"
//   node scripts/run-ingest.mjs --session <id> --arm B --label "contact filter, plain"
//   node scripts/run-compare.mjs --a A --b B
//
// Arms are tags set at ingestion, so the same transcripts can be re-derived and re-tagged
// without re-running anything. With no arms given it lists what the store holds.
//
// It prints per-session figures by default: two arms almost never hold the same number of
// runs, and a total alone reads as a difference that is only a count. `--total` shows the
// raw sums instead.

import { join } from "node:path";
import { REPO } from "./lib/paths.mjs";
import { armStats, compare, perSession } from "./lib/run-compare.mjs";
import { openStore } from "./lib/run-store.mjs";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const value = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : d;
};

const db = openStore(value("db") || join(REPO, ".runs", "runs.sqlite"));

const armA = value("a");
const armB = value("b");

if (!armA || !armB) {
  const rows = db
    .prepare(
      `SELECT arm, COUNT(*) n, COUNT(DISTINCT label) labels FROM runs GROUP BY arm`,
    )
    .all();
  console.log("arms in the store:");
  for (const r of rows)
    console.log(
      `  ${String(r.arm ?? "(untagged)").padEnd(16)} ${String(r.n).padStart(4)} runs`,
    );
  console.log(
    "\nusage: run-compare.mjs --a <arm> --b <arm> [--total]\n" +
      "tag a run at ingestion: run-ingest.mjs --session <id> --arm A --label '...'",
  );
  process.exit(rows.length > 1 ? 0 : 1);
}

const rawA = armStats(db, armA);
const rawB = armStats(db, armB);
for (const [name, s] of [
  [armA, rawA],
  [armB, rawB],
]) {
  if (!s.sessions) {
    console.error(`run-compare: arm \`${name}\` holds no runs`);
    process.exit(1);
  }
}

const total = flag("total");
const a = total ? rawA : perSession(rawA);
const b = total ? rawB : perSession(rawB);

const fmt = (v, kind) => {
  if (kind === "h") return (v / 3600000).toFixed(2) + " h";
  if (kind === "$") return "$" + v.toFixed(2);
  if (kind === "tok") return Math.round(v / 1000) + "k";
  return v < 10 ? v.toFixed(1) : String(Math.round(v));
};

console.log(
  `\n${total ? "totals" : "per session"}   A=${armA} (${rawA.sessions} runs)   ` +
    `B=${armB} (${rawB.sessions} runs)\n`,
);
console.log(
  "  " +
    "measure".padEnd(26) +
    armA.padStart(12) +
    armB.padStart(12) +
    "delta".padStart(10),
);
console.log("  " + "-".repeat(60));

for (const row of compare(a, b)) {
  const delta =
    row.delta === null
      ? "-"
      : (row.delta >= 0 ? "+" : "") + (row.delta * 100).toFixed(0) + "%";
  // Only the arrow says which way is better, and only where the measure has a direction
  // and the gap is more than noise.
  const mark = row.better === "b" ? " B" : row.better === "a" ? " A" : "";
  console.log(
    "  " +
      row.label.padEnd(26) +
      fmt(row.a, row.fmt).padStart(12) +
      fmt(row.b, row.fmt).padStart(12) +
      delta.padStart(10) +
      mark,
  );
}

console.log(
  "\n  delta is B against A. The trailing letter marks the better arm, and only\n" +
    "  where the measure has a direction: more output tokens is not worse, and\n" +
    "  more time in tools is not better.\n",
);
