#!/usr/bin/env node
// What the most recent session of a project was handed, tool by tool.
//
// The one question the big report answers less directly than it should: which tool
// definitions is an agent carrying, and how much does each weigh. It is also the way to
// CHECK a setting rather than trust it — the documentation says `enableArtifact: false`
// turns the Artifact tool off, and says nothing about whether that removes its definition
// from the context or only refuses the call. Run this before and after; if the tool is
// gone from the list and the initial context dropped by its weight, the setting did what
// it claimed.
//
// Usage:
//   node scripts/run-tools.mjs                 # the current project
//   node scripts/run-tools.mjs '%preschool%'   # any slug fragment

import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { REPO } from "./lib/paths.mjs";

const db = new DatabaseSync(join(REPO, ".runs", "runs.sqlite"));
const slug = process.argv[2] || "%" + REPO.split("/").pop() + "%";
const r = db
  .prepare(
    `SELECT a.session_id, a.agent_id, a.ctx_first, r.started_at
  FROM agents a JOIN runs r USING (session_id)
  WHERE r.slug LIKE ? AND a.role='main' AND a.turns_in_window>0
  ORDER BY r.started_at DESC LIMIT 1`,
  )
  .get(slug);
if (!r) {
  console.log("aucune session");
  process.exit(0);
}
console.log(
  "session la plus recente :",
  r.session_id.slice(0, 8),
  new Date(r.started_at).toISOString().slice(0, 16).replace("T", " "),
);
console.log(
  "contexte initial du thread principal :",
  Math.round(r.ctx_first / 1000) + "k tokens\n",
);
console.log("outils charges :");
let tot = 0;
for (const t of db
  .prepare(
    `SELECT substr(component,6) n, bytes FROM context
  WHERE session_id=? AND agent_id=? AND component LIKE 'tool:%' ORDER BY bytes DESC`,
  )
  .all(r.session_id, r.agent_id)) {
  tot += t.bytes;
  console.log(
    "  " + t.n.padEnd(26),
    String(Math.round(t.bytes / 1024) + " KB").padStart(7),
  );
}
console.log(
  "  " + "TOTAL".padEnd(26),
  String(Math.round(tot / 1024) + " KB").padStart(7),
  "=",
  Math.round(tot / 4 / 1000) + "k tokens",
);
