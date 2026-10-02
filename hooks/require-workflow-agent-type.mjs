#!/usr/bin/env node
// PreToolUse(Workflow) — refuse a workflow script whose agents have no identity.
//
// Measured on a probe run: a workflow agent reaches every hook as
// `agent_type: "workflow-subagent"` unless the script passes `agentType` in the options
// of its `agent()` call. Pass it, and the hooks see the real role:
//
//   agent('...')                              -> agent_type=workflow-subagent
//   agent('...', { agentType: 'developer' })  -> agent_type=developer
//
// PreToolUse, PostToolUse and SubagentStop all fire either way, so nothing errors. What
// breaks is every guard keyed on WHO is calling: the orchestrator allowlist, the dev
// dispatch rules, the review verdict chain. They do not refuse, they simply never match,
// and the run completes with its gates inert. That is the failure mode `completion-invariant`
// already had once, where a guard looked in a directory that never existed and reported
// nothing for months.
//
// Fail closed on identity, fail open on ignorance: a call site whose options come from a
// variable cannot be read statically, and is allowed rather than guessed at.

import { readFileSync } from "node:fs";
import { runStandalone } from "./lib/hook-chain.mjs";

/**
 * The source with every string and comment blanked out, character for character.
 *
 * Searching the raw text finds `agent(` inside a prompt, and a prompt that says "spawn an
 * agent(x) for each file" is not a dispatch. Blanking rather than removing keeps every
 * offset aligned, so a position found in the mask is the same position in the source.
 *
 * Template interpolations are blanked with the rest of the literal, so a dispatch written
 * inside `${...}` is not seen. That direction is the safe one: the guard stays silent
 * rather than refusing something it has misread.
 *
 * @param {string} src
 * @returns {string}
 */
export function maskLiterals(src) {
  const out = src.split("");
  const blank = (from, to) => {
    for (let i = from; i < to && i < out.length; i++)
      if (out[i] !== "\n") out[i] = " ";
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      const end = src.indexOf("\n", i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
    } else if (c === "/" && next === "*") {
      const end = src.indexOf("*/", i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === "\\") j++;
        else if (src[j] === c) break;
      }
      blank(i, Math.min(j + 1, src.length));
      i = j;
    }
  }
  return out.join("");
}

/**
 * The `agent(` call sites in a script, each with the source text of its own arguments.
 *
 * Found by scanning rather than parsing: the body is plain JavaScript with no imports, and
 * a parser would be a dependency the hooks do not take. The lookbehind keeps `subagent`,
 * `myAgent` and property accesses from matching.
 *
 * Each site carries its arguments twice. `args` is masked, and every test runs against
 * it, so a prompt whose text contains `agentType:` cannot vouch for a call that has none.
 * `raw` is the real source at the same offsets, and is only ever shown to a reader.
 *
 * @param {string} src
 * @returns {{args: string, raw: string, at: number}[]}
 */
export function agentCalls(src) {
  const mask = maskLiterals(src);
  const out = [];
  const re = /(?<![\w$.])agent\s*\(/g;
  let m;
  while ((m = re.exec(mask))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(mask, open);
    if (close === -1) continue; // unbalanced: unreadable, so not ours to judge
    out.push({
      args: mask.slice(open + 1, close),
      raw: src.slice(open + 1, close),
      at: m.index,
    });
  }
  return out;
}

/** Index of the `)` closing the `(` at `open`, in already-masked source. */
function matchParen(masked, open) {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    if (masked[i] === "(") depth++;
    else if (masked[i] === ")") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * The call sites that name no agent type and could have.
 *
 * A site is left alone when its options are an identifier or a spread: the value is only
 * known at run time, and refusing it would be a guess. Nested `agent(` calls inside this
 * one belong to their own site, so their options do not count for this one.
 *
 * @param {string} src
 * @returns {{at: number, preview: string}[]}
 */
export function untypedCalls(src) {
  const calls = agentCalls(src);
  const bad = [];
  for (const call of calls) {
    const own = withoutNested(call.args);
    if (/\bagentType\s*:/.test(own)) continue;
    // `agent(p, OPTS)` or `agent(p, { ...OPTS })`: the options are computed, so whether
    // they carry an agentType cannot be read here.
    if (/,\s*[A-Za-z_$][\w$]*\s*\)?\s*$/.test(own)) continue;
    if (/\.\.\./.test(own)) continue;
    bad.push({ at: call.at, preview: preview(call.raw) });
  }
  return bad;
}

/** Arguments with any nested `agent(...)` removed, so a child's options stay the child's. */
function withoutNested(args) {
  let out = args;
  for (const nested of agentCalls(args))
    out = out.replace(nested.args, " ".repeat(Math.min(nested.args.length, 2)));
  return out;
}

function preview(args) {
  return args.replace(/\s+/g, " ").trim().slice(0, 70);
}

/** The script this call would run, from whichever input carries it. */
function scriptOf(input) {
  const ti = input.tool_input || {};
  if (typeof ti.script === "string" && ti.script.trim()) return ti.script;
  if (typeof ti.scriptPath === "string" && ti.scriptPath) {
    try {
      return readFileSync(ti.scriptPath, "utf8");
    } catch {
      return null; // unreadable: not ours to judge
    }
  }
  // A saved or bundled workflow run by `name` ships no source here. Those are reviewed
  // when they are saved, not on every run.
  return null;
}

export function check(input, ctx) {
  const src = scriptOf(input);
  if (!src) return;

  const bad = untypedCalls(src);
  if (!bad.length) return;

  const sites = bad.map((b) => `  - agent(${b.preview})`).join("\n");
  ctx.block({
    reason:
      `This workflow has ${bad.length} agent() call${bad.length > 1 ? "s" : ""} with no ` +
      `\`agentType\`:\n${sites}\n\n` +
      `A workflow agent reaches every hook as \`workflow-subagent\` unless the call names ` +
      `its type, so the harness guards keyed on the role never match and the run completes ` +
      `with its gates inert. Nothing errors, which is why this is refused rather than ` +
      `warned about.\n\n` +
      `Add the type to each call, for example:\n` +
      `  agent(prompt, { agentType: 'developer', label: '...' })\n\n` +
      `If an agent genuinely has no harness role, say so explicitly with ` +
      `\`agentType: 'general-purpose'\`.`,
    log: `BLOCK workflow with ${bad.length} untyped agent() call(s)`,
  });
}

runStandalone(import.meta.url, "require-workflow-agent-type", check);
