export const meta = {
  name: "harness-execute-plan",
  description:
    "Execute an approved ticket set: develop, review, fix, merge, promote",
  phases: [
    {
      title: "Develop",
      detail: "one developer per ticket, in its own worktree",
    },
    { title: "Review", detail: "quality-reviewer, with bounded fix rounds" },
    { title: "Merge", detail: "Stage A into the session branch, serialised" },
    { title: "Promote", detail: "session branch into the base branch" },
  ],
};

// The harness pipeline with the orchestrator replaced by this script.
//
// It drives the same agents, with the same dispatch prompts, through the same stages as
// STATE B of agents/orchestrator.md. What it does not do is hold the plan in a context
// window. STATE B spends most of its length teaching a model to do reliably what a loop
// does for free: never re-dispatch on an async acknowledgement, never dispatch the same
// role twice for one ticket, keep a per-ticket state note, and above all "never hold a
// finished ticket waiting for its wave-mates" — which is the definition of pipeline().
//
// Scope stops at promotion. POST-DEV's migration gate asks the user a question, and a
// workflow run cannot pause for one.
//
// args: {
//   sessionShort, worktreeBase, ticketsDir,   // the session's topology
//   tickets: [{ id, dependencies, parallel_safe, tier }],
//   reviewModel: { trivial, normal, hard, critical },   // from harness.config.json
//   maxRetries,
// }

const A = args || {};
const WB = A.worktreeBase;
const TD = A.ticketsDir;
const SS = A.sessionShort;
const MAX_RETRIES = A.maxRetries == null ? 2 : A.maxRetries;
const WAVE_CAP = 5;

if (!WB || !TD || !SS)
  throw new Error("args needs sessionShort, worktreeBase and ticketsDir");
if (!Array.isArray(A.tickets) || !A.tickets.length)
  throw new Error("args.tickets is empty");

// Dependency-ordered waves, exactly the rules STATE B parses by hand.
// Tested through scripts/test/harness-execute-plan.test.mjs, which reads this very
// function out of this file rather than keeping a second copy of it.
function toWaves(tickets, cap) {
  const byId = new Map(tickets.map((t) => [t.id, t]));
  const merged = new Set();
  const left = tickets.slice();
  const waves = [];
  while (left.length) {
    const ready = left.filter((t) =>
      (t.dependencies || []).every((d) => merged.has(d) || !byId.has(d)),
    );
    // Nothing ready and work left means a dependency cycle, or a dependency on a ticket
    // that is not in this set. Failing here beats looping forever or silently dropping.
    if (!ready.length)
      throw new Error(
        "unsatisfiable dependencies: " + left.map((t) => t.id).join(", "),
      );
    // A ticket the planner marked unsafe to parallelise takes a wave of its own.
    const solo = ready.find((t) => t.parallel_safe === false);
    const wave = solo ? [solo] : ready.slice(0, cap);
    waves.push(wave);
    for (const t of wave) {
      merged.add(t.id);
      left.splice(left.indexOf(t), 1);
    }
  }
  return waves;
}

const devPrompt = (t, extra) =>
  "ROLE: developer\n" +
  "TASK_ID: " +
  t.id +
  "\n" +
  "TICKET_FILE: " +
  TD +
  "/" +
  t.id +
  ".json\n" +
  "WORKTREE_PATH: " +
  WB +
  "/" +
  t.id +
  "\n" +
  "BRANCH_NAME: " +
  SS +
  "/" +
  t.id +
  (extra ? "\n" + extra : "");

const reviewPrompt = (t, extra) =>
  "ROLE: quality-reviewer\n" +
  "TASK_ID: " +
  t.id +
  "\n" +
  "TICKET_FILE: " +
  TD +
  "/" +
  t.id +
  ".json\n" +
  "WORKTREE_PATH: " +
  WB +
  "/" +
  t.id +
  (extra ? "\n" + extra : "");

const mergePrompt = (t) =>
  "ROLE: merger\n" +
  "TASK_ID: " +
  t.id +
  "\n" +
  "STAGE: a-only\n" +
  "BRANCH_NAME: " +
  SS +
  "/" +
  t.id +
  "\n" +
  "WORKTREE_PATH: " +
  WB +
  "/" +
  t.id +
  "\n" +
  "SESSION_SHORT_ID: " +
  SS +
  "\n" +
  "TICKETS_DIR: " +
  TD;

// The model the reviewer runs on is a config lookup, not a hook: route-review-model
// exists only because the Agent path had nowhere else to put it.
const reviewModelFor = (t) => (A.reviewModel || {})[t.tier || "normal"];

// The agents keep emitting their OUTPUT-CONTRACT line and this script reads it, rather
// than being forced into StructuredOutput by a `schema`. Not a style choice: the
// SubagentStop hooks parse the SAME line. `record-review-verdict` reads the reviewer's
// last assistant text and writes the `reviews/<TASK>-quality-reviewer` flag that
// `block-merger-without-review` then requires. An agent answering with a structured tool
// call instead leaves that text empty, the flag unwritten and the merge refused, with
// nothing in the run saying why.
//
// These mirror hooks/lib/verdict.mjs and the developer's DONE contract. The tests check
// them against the real parser over a table of cases, so a change there fails here.

/** "APPROVED" | "REJECTED" | "", from the last contract line present. */
function parseVerdict(text) {
  const lines = String(text == null ? "" : text)
    .split("\n")
    .map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    if (/^(REJECTED|BLOCKED):/.test(line)) return "REJECTED";
    if (line.replace(/[.!\s]+$/, "") === "APPROVED") return "APPROVED";
  }
  return "";
}

/** The reviewer's own words, for the retry prompt: everything after the marker. */
function rejectionBody(text) {
  const lines = String(text == null ? "" : text).split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].trim().match(/^(?:REJECTED|BLOCKED):\s*(.*)$/);
    if (m) return [m[1], ...lines.slice(i + 1)].join("\n").trim();
  }
  return "";
}

/** A developer reports `DONE: branch=... commit=...`, or `FAILED: <reason>`. */
function developerDone(text) {
  const lines = String(text == null ? "" : text)
    .split("\n")
    .map((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^DONE\b/.test(lines[i])) return { ok: true, line: lines[i] };
    const failed = lines[i].match(/^FAILED:\s*(.*)$/);
    if (failed)
      return { ok: false, why: failed[1] || "developer reported FAILED" };
  }
  return { ok: false, why: "no DONE or FAILED contract line" };
}

/** Develop, review, and re-develop on a rejection, up to MAX_RETRIES. */
async function untilApproved(ticket) {
  let dev = developerDone(
    await agent(devPrompt(ticket), {
      agentType: "aiharness:developer",
      label: "dev:" + ticket.id,
      phase: "Develop",
    }),
  );
  if (!dev.ok) return { ticket, ok: false, why: dev.why };

  for (let round = 0; round <= MAX_RETRIES; round++) {
    const said = await agent(reviewPrompt(ticket), {
      agentType: "aiharness:quality-reviewer",
      label: "review:" + ticket.id + (round ? " r" + round : ""),
      phase: "Review",
      model: reviewModelFor(ticket),
    });
    // STATE B: "malformed reviewer output -> treat as REJECTED". Neither a failure nor
    // an approval: the ticket goes round again. The hooks agree, since a review with no
    // clean marker leaves the flag unwritten and the merge refused anyway. Reading it as
    // a failure instead would end the ticket where arm A would have retried it, which is
    // the kind of divergence that makes an A/B meaningless.
    const verdict = parseVerdict(said);
    if (verdict === "APPROVED") return { ticket, ok: true };
    if (round === MAX_RETRIES)
      return {
        ticket,
        ok: false,
        why: "still rejected after " + MAX_RETRIES + " fix rounds",
      };

    // The retry reuses the Stage 1 prompt verbatim, identity lines included: a retry is a
    // fresh agent with no memory of the first attempt.
    dev = developerDone(
      await agent(devPrompt(ticket, "RETRY_FEEDBACK=" + rejectionBody(said)), {
        agentType: "aiharness:developer",
        label: "fix:" + ticket.id + " r" + (round + 1),
        phase: "Develop",
      }),
    );
    if (!dev.ok) return { ticket, ok: false, why: dev.why };
  }
  return { ticket, ok: false, why: "exhausted fix rounds" };
}

const waves = toWaves(A.tickets, WAVE_CAP);
log(waves.length + " wave(s) from " + A.tickets.length + " ticket(s)");

const merged = [];
const failed = [];

for (let w = 0; w < waves.length; w++) {
  const wave = waves[w];
  log(
    "wave " +
      (w + 1) +
      "/" +
      waves.length +
      ": " +
      wave.map((t) => t.id).join(", "),
  );

  // pipeline, not parallel: a ticket that passes review goes on while its wave-mates are
  // still being developed. STATE B measures what the barrier costs — one run held a
  // finished ticket for 3 minutes 46 seconds waiting for a slower sibling.
  const results = await pipeline(wave, (t) => untilApproved(t));

  // Merges serialise: they share one branch and one worktree.
  for (const r of results) {
    if (!r) {
      failed.push({ id: "unknown", why: "pipeline dropped the ticket" });
      continue;
    }
    if (!r.ok) {
      failed.push({ id: r.ticket.id, why: r.why });
      continue;
    }
    const m = await agent(mergePrompt(r.ticket), {
      agentType: "aiharness:merger",
      label: "merge:" + r.ticket.id,
      phase: "Merge",
    });
    if (m && /DONE/.test(String(m))) merged.push(r.ticket.id);
    else
      failed.push({
        id: r.ticket.id,
        why: "merge failed: " + String(m).slice(0, 200),
      });
  }
}

// A wave whose tickets all failed leaves later waves with unmet dependencies; they were
// still attempted above, and their own failures are recorded. Nothing is dropped quietly.
if (!merged.length) {
  log("no ticket merged, so there is nothing to promote");
  return { merged, failed, promoted: false };
}

phase("Promote");
const promotion = await agent(
  "ROLE: merger\nMODE: promote\nSESSION_SHORT_ID: " +
    SS +
    "\nTICKETS_DIR: " +
    TD +
    "\n\nPromote the session branch into the branch it was forked from. Stage B only.",
  { agentType: "aiharness:merger", label: "promote", phase: "Promote" },
);

return {
  merged,
  failed,
  promoted: Boolean(promotion && /DONE/.test(String(promotion))),
  promotionReport: String(promotion || "").slice(0, 400),
};
