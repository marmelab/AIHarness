#!/usr/bin/env node
// Wall-clock timeline of one harness session: per-agent span, concurrency, and the gaps.
//
// Cost and TIME do not distribute the same way, and only one of them is visible in a
// transcript's usage totals. A session reported as "80 minutes" turned out to be 61 minutes
// of harness work, 10 of waiting for a human at the two gates, and 5 of an idle session left
// open — so the first optimisation was to stop counting the last two.
//
// What it answers: which phases are serial, which agent is the longest pole, how much of the
// run had nothing running, and how much time goes into the orchestrator's turnaround between
// one agent stopping and the next starting.
//
// Usage: node scripts/session-timeline.mjs <session-id> [--project <slug>]
//   <slug> defaults to the current repo's transcript directory name under
//   ~/.claude/projects. Reads transcripts only; writes nothing.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { REPO, CONFIG_DIR } from "../hooks/lib/paths.mjs";

const args = process.argv.slice(2);
const sessionId = args.find((a) => !a.startsWith("--")) || "";
const slugFlag = args.indexOf("--project");
const slug =
  slugFlag !== -1 && args[slugFlag + 1]
    ? args[slugFlag + 1]
    : REPO.replace(/\//g, "-");

if (!sessionId) {
  console.error(
    "usage: node scripts/session-timeline.mjs <session-id> [--project <slug>]",
  );
  process.exit(1);
}

const projectDir = join(CONFIG_DIR, "projects", slug);
const mainTranscript = join(projectDir, `${sessionId}.jsonl`);
if (!existsSync(mainTranscript)) {
  console.error(`no transcript at ${mainTranscript}`);
  process.exit(1);
}

/** First and last event timestamps of a transcript, or null when it has none. */
const span = (file) => {
  const ts = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.timestamp) ts.push(Date.parse(event.timestamp));
  }
  if (!ts.length) return null;
  ts.sort((a, b) => a - b);
  return { start: ts[0], end: ts[ts.length - 1] };
};

const main = span(mainTranscript);
const T0 = main.start;
const mins = (ms) => (ms / 60000).toFixed(1);
const rel = (t) => mins(t - T0).padStart(6);

const subagents = join(projectDir, sessionId, "subagents");
const agents = [];
if (existsSync(subagents)) {
  for (const f of readdirSync(subagents).filter((x) =>
    /^agent-.+\.jsonl$/.test(x),
  )) {
    const id = basename(f, ".jsonl").replace(/^agent-/, "");
    let meta = {};
    try {
      meta = JSON.parse(
        readFileSync(join(subagents, `agent-${id}.meta.json`), "utf8"),
      );
    } catch {
      // a transcript with no meta still has a span worth showing
    }
    const s = span(join(subagents, f));
    if (!s) continue;
    agents.push({
      role: (meta.agentType || "?").replace(/^[\w.-]+:/, ""),
      desc: (meta.description || "").slice(0, 36),
      ...s,
    });
  }
}
agents.sort((a, b) => a.start - b.start);

console.log(`session ${sessionId}`);
console.log(`wall clock ${mins(main.end - T0)} min\n`);
console.log(" start    end    dur  role              description");
for (const a of agents)
  console.log(
    `${rel(a.start)} ${rel(a.end)} ${mins(a.end - a.start).padStart(6)}  ${a.role.padEnd(17)} ${a.desc}`,
  );

// The orchestrator's own span covers every agent it dispatched, so counting it would report
// the whole run as one long agent. Concurrency and gaps are about the WORK.
const work = agents.filter((a) => !/orchestrator/.test(a.role));

const BUCKET = 30000;
const buckets = Math.max(1, Math.ceil((main.end - T0) / BUCKET));
const busy = new Array(buckets).fill(0);
for (const a of work)
  for (
    let b = Math.max(0, Math.floor((a.start - T0) / BUCKET));
    b <= Math.min(buckets - 1, Math.floor((a.end - T0) / BUCKET));
    b++
  )
    busy[b]++;

const count = (pred) => busy.filter(pred).length;
console.log(`\nconcurrency (30s buckets):`);
console.log(`  nothing running : ${mins(count((n) => n === 0) * BUCKET)} min`);
console.log(`  one agent       : ${mins(count((n) => n === 1) * BUCKET)} min`);
console.log(`  two or more     : ${mins(count((n) => n > 1) * BUCKET)} min`);
console.log(`  peak parallel   : ${Math.max(0, ...busy)} agents`);

// Turnaround: the orchestrator reading a contract line and dispatching the next agent. Only
// counted when NOTHING was running, so overlapping waves are not charged for it.
let turnaround = 0;
for (let i = 1; i < work.length; i++) {
  const prevEnd = Math.max(...work.slice(0, i).map((a) => a.end));
  if (work[i].start > prevEnd) turnaround += work[i].start - prevEnd;
}
const sum = work.reduce((s, a) => s + (a.end - a.start), 0);
console.log(`\nsum of work spans   : ${mins(sum)} min`);
console.log(`wall clock          : ${mins(main.end - T0)} min`);
console.log(
  `parallelism         : ${(sum / Math.max(1, main.end - T0)).toFixed(2)}x`,
);
console.log(
  `idle between agents : ${mins(turnaround)} min (orchestrator turnaround + any gate)`,
);

const byRole = {};
for (const a of work) {
  const r = (byRole[a.role] ??= { n: 0, ms: 0, max: 0 });
  r.n++;
  r.ms += a.end - a.start;
  r.max = Math.max(r.max, a.end - a.start);
}
console.log(`\nper role:`);
for (const [role, v] of Object.entries(byRole).sort((a, b) => b[1].ms - a[1].ms))
  console.log(
    `  ${role.padEnd(17)} n=${String(v.n).padStart(2)}  total ${mins(v.ms).padStart(6)} min  longest ${mins(v.max)} min`,
  );
