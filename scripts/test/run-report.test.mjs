// Tests for the report generator, driven through spawnSync like the other CLI tests.
//
// Two properties, both learned the hard way. The page is assembled inside one template
// literal, so its own prose can break it three ways: a backtick closes the literal, a
// double quote closes the page's own JS string, and a `${` interpolates. Two of those
// shipped before the generator started parsing what it produced.
//
// And every figure has to carry its definition, because not one of these numbers means the
// obvious thing: a duration is capped, a cost is windowed, a token count is an estimate.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "vitest";
import { makeClassifier } from "../lib/activity.mjs";
import { buildRun } from "../lib/run-model.mjs";
import { openStore, writeRun } from "../lib/run-store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "run-report.mjs");
const classify = makeClassifier();
const T0 = Date.parse("2026-09-01T10:00:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

const usage = {
  input_tokens: 0,
  output_tokens: 40,
  cache_read_input_tokens: 20000,
  cache_creation_input_tokens: 0,
};
const turn = (ms, id, tool, input) =>
  JSON.stringify({
    type: "assistant",
    timestamp: at(ms),
    message: {
      id,
      model: "claude-sonnet-5",
      usage,
      content: [{ type: "tool_use", id: "u" + id, name: tool, input }],
    },
  });
const result = (ms, id) =>
  JSON.stringify({
    type: "user",
    timestamp: at(ms),
    message: {
      content: [{ type: "tool_result", tool_use_id: "u" + id, content: "ok" }],
    },
  });
const attach = (ms, a) =>
  JSON.stringify({ type: "attachment", timestamp: at(ms), attachment: a });

const mainBody = [
  turn(0, "m1", "Read", { file_path: "/before.ts" }),
  result(500, "m1"),
  turn(60000, "m2", "Bash", { command: "git status" }),
  result(61000, "m2"),
].join("\n");

const devBody = [
  attach(59000, {
    type: "prompt_snapshot",
    // The real shape: the system prompt is a list of blocks and the tools are a list of
    // definitions, which is what makes each tool sizeable on its own.
    systemPrompt: ["s".repeat(800)],
    tools: [
      {
        name: "Bash",
        description: "run a command",
        schema: { x: "b".repeat(4000) },
      },
      {
        name: "Read",
        description: "read a file",
        schema: { x: "r".repeat(900) },
      },
    ],
  }),
  attach(59100, {
    type: "skill_listing",
    content: "k".repeat(500),
    skillCount: 2,
    names: ["pr", "commit"],
  }),
  attach(59200, {
    type: "instructions",
    files: [{ path: "/p/CLAUDE.md", content: "c".repeat(400) }],
  }),
  attach(59300, {
    type: "hook_success",
    hookName: "format-on-write",
    hookEvent: "PostToolUse",
    durationMs: 30,
    exitCode: 0,
  }),
  turn(60000, "d1", "Edit", { file_path: "/src/a.ts", old_string: "x" }),
  result(62000, "d1"),
  turn(65000, "d2", "Bash", { command: "npm test" }),
  result(70000, "d2"),
].join("\n");

let TMP = null;
afterEach(() => {
  if (TMP) rmSync(TMP, { recursive: true, force: true });
  TMP = null;
});

function build(flags = []) {
  TMP = mkdtempSync(join(tmpdir(), "run-report-"));
  const dbFile = join(TMP, "runs.sqlite");
  const db = openStore(dbFile);
  writeRun(
    db,
    buildRun({
      sessionId: "sess-report-1",
      slug: "-fixture",
      mainBody,
      agents: [
        {
          agentId: "dev-1",
          body: devBody,
          meta: { agentType: "aiharness:developer" },
        },
      ],
      classify,
    }),
  );
  const out = join(TMP, "report.html");
  const run = spawnSync(
    process.execPath,
    [SCRIPT, "--db", dbFile, "--out", out, ...flags],
    {
      encoding: "utf8",
    },
  );
  return { run, out, html: run.status === 0 ? readFileSync(out, "utf8") : "" };
}

/** The embedded payload of a built page. */
const payloadOf = (html) =>
  JSON.parse(
    html
      .match(
        /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
      )[1]
      .replace(/<\\\/script/g, "</script"),
  );

describe("the generated page", () => {
  test("is written, and the generator says where", () => {
    const { run, html } = build();
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("report.html");
    expect(html).toContain("<title>Harness Run Anatomy</title>");
  });

  test("its inline script parses", () => {
    // The guard the generator runs on itself. A backtick or a double quote in a tooltip
    // used to produce a page that rendered its layout and then died on the first line of
    // script, which reads as a dashboard that simply ignores every click.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(script).not.toBe(null);
    expect(() => new Function(script[1])).not.toThrow();
  });

  test("its embedded data parses, with the script-closing sequence escaped", () => {
    const { html } = build();
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    expect(() => JSON.parse(json)).not.toThrow();
    expect(json).not.toContain("</script");
  });

  test("loads nothing from a host outside the artifact CSP allowlist", () => {
    const { html } = build();
    const hrefs = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(
      (m) => m[1],
    );
    for (const url of hrefs)
      expect(url).toMatch(/^https:\/\/fonts\.(googleapis|gstatic)\.com/);
  });

  test("every figure carries a definition of what it covers", () => {
    // Each tile and panel is rendered from a key, and the key must resolve to BOTH a title
    // and a definition. A figure with no definition is a number nobody can check.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const keys = [
      ...new Set(
        [...script.matchAll(/\b(?:tileK|panelK)\(\s*"([A-Za-z0-9]+)"/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    expect(keys.length).toBeGreaterThan(20);
    const dict = script.slice(
      script.indexOf("const L = {"),
      script.indexOf("const S = {"),
    );
    for (const key of keys) {
      const at = dict.indexOf("\n  " + key + ": [");
      expect(at, key + " has no entry in the dictionary").toBeGreaterThan(-1);
      // The entry holds two pairs: [title en, title fr] then [tip en, tip fr].
      const entry = dict.slice(at, dict.indexOf("\n  ],", at));
      const strings = [...entry.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map(
        (m) => m[1],
      );
      expect(strings.length, key + " is missing a title or a definition").toBe(
        4,
      );
      expect(
        strings[2].length,
        key + " has no English definition",
      ).toBeGreaterThan(40);
      expect(
        strings[3].length,
        key + " has no French definition",
      ).toBeGreaterThan(40);
    }
  });

  test("every figure is defined in BOTH languages", () => {
    // A title translated but a definition left in English is worse than one language
    // throughout: the reader trusts the page to explain itself and it half does.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const dict = script.slice(
      script.indexOf("const L = {"),
      script.indexOf("const S = {"),
    );
    const pairs = [
      ...dict.matchAll(
        /\[\s*"((?:[^"\\]|\\.)+)",\s*\n?\s*"((?:[^"\\]|\\.)+)",?\s*\]/g,
      ),
    ];
    expect(pairs.length).toBeGreaterThan(25);
    for (const [, en, fr] of pairs) {
      expect(en.length).toBeGreaterThan(0);
      expect(fr.length).toBeGreaterThan(0);
      // A definition that is byte-identical across the two columns was not translated.
      if (en.length > 60) expect(fr).not.toBe(en);
    }
  });

  test("offers both languages and remembers the choice", () => {
    const { html } = build();
    expect(html).toContain('data-lang="0"');
    expect(html).toContain('data-lang="1"');
    expect(html).toContain("runAnatomyLang");
    // Storage can throw in a private window; the page must still render.
    expect(html).toMatch(/try \{[\s\S]{0,200}localStorage/);
  });

  test("the tooltip waits for the pointer to settle", () => {
    // Shown instantly and repositioned on every mousemove, it flashed through a dozen
    // states while crossing the page and could not be read at all.
    const { html } = build();
    const delay = html.match(/const TIP_DELAY_MS = (\d+);/);
    expect(delay).not.toBe(null);
    expect(Number(delay[1])).toBeGreaterThanOrEqual(200);
    expect(html).toContain("if (el === tipTarget) return;");
  });

  test("a call that blocks on someone else is not counted as the caller's work", () => {
    // An Agent call lasts exactly as long as the child it spawned, and an AskUserQuestion
    // lasts as long as the human thinks. Counting either as tool work both overstates the
    // caller and counts the child twice: on one archived run it was 51% of the total.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain('const BLOCKED = new Set(["dispatch", "ask"])');
    expect(script).toMatch(
      /isOwnWork\s*=\s*\(a\)\s*=>\s*!NOT_WORK\.has\(a\)\s*&&\s*!BLOCKED\.has\(a\)/,
    );
    // And the figures must be built from it, not from the old "everything but wait" rule.
    expect(script).toContain("filter((a) => isOwnWork(a.activity))");
    expect(script).not.toContain("filter((a) => !NOT_WORK.has(a.activity))");
  });

  test("the timeline can be zoomed and reset", () => {
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("function wireTimeline(");
    expect(script).toMatch(/clock\.inv\(/);
    expect(script).toContain("tlreset");
  });

  test("a tooltip wraps prose between words, not inside them", () => {
    // word-break: break-all split French sentences mid-letter and made the definitions
    // unreadable, which is the one thing they exist to avoid.
    const { html } = build();
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    expect(css).not.toMatch(/#tip[\s\S]{0,400}word-break:\s*break-all/);
    expect(css).toMatch(/#tip b \{[^}]*overflow-wrap: break-word/);
    expect(css).toMatch(/#tip i \{[^}]*overflow-wrap: anywhere/);
  });

  test("every activity bucket is defined, in both languages", () => {
    // A legend that names a bucket without saying what falls in it is a colour key, not a
    // legend. "app", "exec" and "dispatch" mean nothing on their own.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    const defs = script.slice(
      script.indexOf("const ACT_DEF = {"),
      script.indexOf("const actDef ="),
    );
    for (const bucket of [
      "explore",
      "write",
      "validate",
      "exec",
      "runtime",
      "dispatch",
      "git",
      "integration",
      "wait",
      "idle",
    ]) {
      const at = defs.indexOf("\n  " + bucket + ": [");
      expect(at, bucket + " has no definition").toBeGreaterThan(-1);
      const entry = defs.slice(at, defs.indexOf("\n  ],", at) + 1);
      const strings = [...entry.matchAll(/"((?:[^"\\]|\\.)+)"/g)].map(
        (m) => m[1],
      );
      expect(strings.length, bucket + " is missing a language").toBe(2);
      expect(strings[0].length).toBeGreaterThan(15);
      expect(strings[1].length).toBeGreaterThan(15);
    }
  });

  test("an aggregate can be opened: tools and activities carry a drill-down hook", () => {
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("data-tool=");
    expect(script).toContain("data-activity=");
    expect(script).toMatch(/function drill\(/);
  });

  test("the timeline compresses stretches where nothing ran", () => {
    // A run can hold a 64-hour gap in its middle. On a linear axis every band then
    // collapses to a pixel at each end with a desert between them.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("compressedClock");
    const gap = script.match(/const TIMELINE_GAP_MS = (\d+);/);
    expect(gap).not.toBe(null);
    expect(Number(gap[1])).toBeGreaterThan(0);
  });

  test("reports what the analysis is actually for", () => {
    // The page exists to answer five questions about a harness, not to show the data that
    // happened to be available. These are the figures that decide something.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    for (const key of [
      "preambleTax", //  what share of the bill re-read the same header
      "coordination", // the turnaround the harness owns
      "stalls", //       the pauses that have their own causes
      "busy",
      "reread", //       reads of a file the agent had already opened
      "errorRate",
      "perTurn",
    ])
      expect(script, key + " is not reported").toContain('"' + key + '"');
  });

  test("a ratio never divides by a base that includes dead time", () => {
    // Parallelism against the window would credit a run for the hours nobody worked, and
    // the longest agent must not be the host session, which spans the whole conversation.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("busyMs > 0 ? agentMs / busyMs : 0");
    expect(script).toMatch(
      /filter\(\(a\) => a\.agent_id !== "main" && a\.turns_in_window > 0\)/,
    );
  });

  test("quiet time is split at the stall threshold, not averaged", () => {
    // One 90-minute pause and 183 two-second ones are different phenomena. Reported as a
    // single "dead time" the figure described neither and suggested a cause it did not
    // have: recorded hooks accounted for 0.6% of it.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain('"coordination"');
    expect(script).toContain('"stalls"');
    expect(script).not.toContain('tileK(\n      "deadTime"');
  });

  test("a tool whose duration is someone else's time is ranked apart", () => {
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("const ownTools = d.tools.filter");
    expect(script).toContain('"pDispatches"');
    // And the ranking itself must be built from the filtered list.
    expect(script).toContain("ownTools.map((t) => [");
  });

  test("a donut slice explains itself, it does not repeat its own value", () => {
    // "app 81%" named nothing. The hover now carries the bucket's definition.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("def: actDef(a.activity)");
    expect(script).toContain('esc(it.def || "")');
  });

  test("a stall is an entry point, not just a duration", () => {
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("data-stall=");
    expect(script).toContain("function drillStall(");
    // Present is not enough: the click has to reach it, and the row has to carry the index.
    expect(script).toContain("drill({ stall: Number(el.dataset.stall) })");
    expect(script).toMatch(/sel\.stall !== undefined[\s\S]{0,80}drillStall\(/);
    // The evidence it opens on: what ran either side, and any hook line inside.
    expect(script).toContain('tr("lastBefore")');
    expect(script).toContain('tr("firstAfter")');
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    for (const id of data.picked)
      for (const g of data.detail[id].stalls)
        expect(Object.keys(g)).toEqual(
          expect.arrayContaining(["before", "after", "hooks"]),
        );
  });

  test("the preamble is measured, not reconstructed from the attachments", () => {
    // The attachment breakdown only exists on sessions recorded after Claude Code started
    // emitting it. Sizing the preamble from it reported 2% on a 2026-09-07 run whose
    // measured figure is 19%, because only one component of seven was there. ctx_first is
    // the billed context of the agent's first turn and exists for every agent ever.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("sum + (a.tokens || 0) * a.turns");
    expect(script).not.toContain("((a.bytes || 0) / 4) * a.turns");
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    for (const id of data.picked)
      for (const a of data.detail[id].preamble)
        expect(
          a.tokens,
          "an agent with no measured first context",
        ).toBeGreaterThan(0);
  });

  test("a partial context breakdown says so instead of looking like a finding", () => {
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain('"pCoverage"');
    expect(script).toContain("cov.known < cov.total");
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    for (const id of data.picked) {
      const c = data.detail[id].contextCoverage;
      expect(c).toMatchObject({
        known: expect.any(Number),
        total: expect.any(Number),
      });
    }
  });

  test("the waste figure counts re-reads, not reads", () => {
    // Reading files is what an agent does; the share of turns that wrote one said nothing
    // about waste. Opening a file the same agent had already opened does: the first read
    // fell out of the context and the second is paid twice.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain('"reread"');
    expect(script).not.toContain('"productive"');
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    for (const id of data.picked)
      expect(data.detail[id].rereads).toMatchObject({
        total: expect.any(Number),
        again: expect.any(Number),
      });
  });

  test("a part of the context opens onto what is inside it", () => {
    // "51 KB of tool definitions" is a number; "Bash costs 22 KB of every turn" is a
    // decision. Only the parts the transcript itemises can open, and the others say so.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("function drillContext(");
    expect(script).toContain("data-ctx=");
    expect(script).toContain('tools: "tool:"');
    expect(script).toContain('skills: "skill:"');
    expect(script).toContain('instructions: "file:"');
    // A component with no itemisation must fall to the explanatory line, not an empty table.
    expect(script).toContain('tr("noBreakdown")');
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    const items = data.detail[data.picked[0]].contextItems;
    expect(
      items.some((i) => i.component.startsWith("tool:") && i.bytes > 0),
    ).toBe(true);
  });

  test("what a context part opens onto matches the bar that was clicked", () => {
    // Grouped by component alone, every bar opened onto the union of all roles: a planner
    // holding 13 KB of tool definitions showed the main thread's 124 KB.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("data-ctx-role=");
    expect(script).toContain("(!role || i.role === role)");
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    for (const i of data.detail[data.picked[0]].contextItems)
      expect(
        i.role,
        "a context item with no role cannot be scoped",
      ).toBeTruthy();
  });

  test("tokens are broken out by billed kind, with their cost", () => {
    // On a subscription the dollars are an estimate at public rates; the tokens are what a
    // usage limit counts. Both are shown, and the kinds are not interchangeable: a cache
    // read costs a tenth of fresh input, output several times it.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("function tokenKinds(");
    expect(script).toContain('"pTokens"');
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    for (const id of data.picked) {
      const k = data.detail[id].tokenKinds;
      for (const kind of ["input", "cacheRead", "cacheWrite", "output"])
        expect(k[kind], kind).toMatchObject({
          tokens: expect.any(Number),
          usd: expect.any(Number),
        });
      // Scoped to the run window like every other cost: summing the whole session put $37
      // against a run that costs $26.
      const sum = Object.values(k).reduce((s, v) => s + v.usd, 0);
      const run = data.runs.find((r) => r.session_id === id);
      expect(sum).toBeLessThanOrEqual(run.usd + 0.01);
    }
  });

  test("no time share is taken against the end-to-end span", () => {
    // A run is a session, and a session resumed five days later spans 147 hours of which
    // four were work. Percentages against that span say nothing; they are taken against
    // busy plus the short turnarounds.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain("const workingMs = busyMs + coordMs;");
    expect(script).toContain("pct(busyMs, workingMs)");
    expect(script).toContain("pct(coordMs, workingMs)");
    expect(script).not.toContain("pct(busyMs, windowMs)");
    expect(script).not.toContain("pct(coordMs, windowMs)");
  });

  test("hook time is measured, and its blind spot is named", () => {
    // The transcript carries an exact durationMs for every PreToolUse, PostToolUse, Stop
    // and SessionStart execution, so claiming hook time is unknowable was wrong. What it
    // never carries is SubagentStop, which is where the validation chain runs, and the tile
    // has to say so rather than let 46 seconds read as the whole answer.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain('"hookTime"');
    expect(script).toContain('tr("noSubagentStop")');
    const json = html.match(
      /<script type="application\/json" id="data">([\s\S]*?)<\/script>/,
    )[1];
    const data = JSON.parse(json.replace(/<\\\/script/g, "</script"));
    for (const id of data.picked)
      expect(data.detail[id].hookTotal).toMatchObject({
        runs: expect.anything(),
        ms: expect.anything(),
      });
  });

  test("--redact removes every quotation and keeps every figure", () => {
    // The page embeds real data: shell commands in full, absolute paths, agent
    // descriptions. That is what makes a bar worth clicking and what makes the page unfit
    // for a public repository. Redacting has to remove the text and touch no number, or it
    // is not a variant of the same report.
    const plain = payloadOf(build().html);
    const red = payloadOf(build(["--redact"]).html);
    expect(red.redacted).toBe(true);
    expect(plain.redacted).toBe(false);

    const whole = JSON.stringify(red);
    expect(whole, "an absolute path survived").not.toMatch(
      /\/(home|Users|workspaces|var|etc)\//,
    );
    expect(whole, "a shell command survived").not.toMatch(
      /\b(npm|npx|git|curl|node|make|pnpm)\s+[a-z-]/,
    );
    for (const id of red.picked) {
      // Falsy, not strictly null: a field that was already empty round-trips as absent,
      // and absent is as redacted as null.
      for (const c of red.detail[id].calls) {
        expect(c.detail).toBeFalsy();
        expect(c.path).toBeFalsy();
      }
      for (const a of red.detail[id].agents) expect(a.description).toBeFalsy();
      for (const l of red.detail[id].loops) expect(l.detail).toBeFalsy();
    }

    // And every counted thing is untouched, field by field.
    for (const id of plain.picked) {
      const a = plain.detail[id];
      const b = red.detail[id];
      expect(b.tokens).toEqual(a.tokens);
      expect(b.tokenKinds).toEqual(a.tokenKinds);
      expect(b.rereads).toEqual(a.rereads);
      expect(b.activities).toEqual(a.activities);
      expect(b.durations).toEqual(a.durations);
      expect(b.calls.map((c) => c.charged_ms)).toEqual(
        a.calls.map((c) => c.charged_ms),
      );
      expect(b.agents.map((x) => x.usd_in_window)).toEqual(
        a.agents.map((x) => x.usd_in_window),
      );
    }
    const drop = (r) => ({ ...r, slug: null, label: null });
    expect(red.runs.map(drop)).toEqual(plain.runs.map(drop));
    expect(red.totals).toEqual(plain.totals);
  });

  test("a redacted page says it is redacted", () => {
    // Its drill-downs are empty by design, and a reader has to be able to tell that from a
    // tool that simply found nothing.
    const { html } = build(["--redact"]);
    expect(html).toContain('id="redacted"');
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).toContain('tr("redactedBadge")');
    expect(script).toContain("flag.hidden = !D.redacted;");
  });

  test("the default selection ranks on cost, not on how many agents ran", () => {
    // Ranking by agent count returned ten review sessions and not one development session
    // on a real project: a review fans out to ten verification subagents while development
    // is one agent grinding for two hours. The single-agent runs were the expensive ones,
    // 64% of that project's spend, and the ranking hid every one of them.
    const { html } = build();
    const script = html.match(/<script>([\s\S]*?)<\/script>\s*$/)[1];
    expect(script).not.toContain("roleCount");
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toContain("sort((a, b) => b.usd - a.usd)");
    expect(src).not.toMatch(/roleCount\.get/);
  });

  test("refuses a store with no run rather than writing an empty page", () => {
    TMP = mkdtempSync(join(tmpdir(), "run-report-"));
    const dbFile = join(TMP, "empty.sqlite");
    openStore(dbFile);
    const run = spawnSync(
      process.execPath,
      [SCRIPT, "--db", dbFile, "--out", join(TMP, "r.html")],
      { encoding: "utf8" },
    );
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("run-ingest");
  });
});
