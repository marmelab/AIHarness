#!/usr/bin/env node
// PreToolUse(Bash) — any caller. Vets every package an `npm install <pkg>` or `npx <pkg>`
// would fetch, then adds `--ignore-scripts --min-release-age=<days>` so npm itself refuses
// a too-recent version anywhere in the tree, transitive ones included.
//
// Fails CLOSED when the registry cannot be reached: the install needs it anyway, and
// failing open would hand back exactly the unvetted install this replaces.
//
// A project's `permissions.deny` on `Bash(npm install *)` wins over this hook, so the gate
// only takes effect once that deny is removed.

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runStandalone } from "./lib/hook-chain.mjs";
import { findInstalls, parseSpec } from "./lib/install-commands.mjs";
import {
  MIN_RELEASE_AGE_DAYS,
  MIN_WEEKLY_DOWNLOADS,
  fetchFacts,
  refusal,
} from "./lib/npm-registry.mjs";

const PINNED_FLAGS = ` --ignore-scripts --min-release-age=${MIN_RELEASE_AGE_DAYS}`;
const POLICY =
  `Packages an agent adds are vetted automatically: on the npm registry, first published ` +
  `${MIN_RELEASE_AGE_DAYS}+ days ago, ${MIN_WEEKLY_DOWNLOADS}+ weekly downloads, not deprecated, ` +
  `no install script, no high or critical security advisory.`;
const NEXT_STEP =
  "Pick a well-established alternative, or tell the user that a human has to add this package.";

const declaredDependencies = (dir) => {
  try {
    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    return new Set(
      Object.keys({
        ...pkg.dependencies,
        ...pkg.devDependencies,
        ...pkg.optionalDependencies,
        ...pkg.peerDependencies,
      }),
    );
  } catch {
    return new Set();
  }
};

const isLocalBin = (dir, name) =>
  existsSync(join(dir, "node_modules", ".bin", name));

const quoted = (items) => items.map((s) => `\`${s}\``).join(", ");

/**
 * @param {{ cwd?: string, tool_input?: { command?: string } }} input
 * @returns {Promise<null | { block: string, log: string } | { rewrite: string, log: string }>}
 */
export async function decide(input) {
  const command = String(input.tool_input?.command || "");
  const found = findInstalls(command);
  if (!found.length) return null;

  const other = found.find((f) => f.kind === "other");
  if (other)
    return {
      block:
        `Dependency gate: \`${other.manager}\` installs are not vetted, only npm's are ` +
        "(`npm install <pkg>`, `npx <pkg>`). In an npm project use those; otherwise tell the " +
        "user that a human has to add this package.",
      log: `other-manager=${other.manager}`,
    };

  const owned = found.flatMap((f) => f.gateFlags);
  if (owned.length)
    return {
      block:
        `Dependency gate: ${quoted(owned)} would bypass the vetting, which sets the registry, ` +
        `the release-age cutoff and --ignore-scripts itself. Drop the flag. A version younger ` +
        `than ${MIN_RELEASE_AGE_DAYS} days or an install script needs a human.`,
      log: `gate-owned-flags=${owned.join(",")}`,
    };

  const installs = found
    .map((f) => ({
      ...f,
      dir: resolve(input.cwd || process.cwd(), f.cwd || "."),
    }))
    .filter((f) => !(f.binOnly && isLocalBin(f.dir, f.specs[0])));
  if (!installs.length) return null;

  const specs = installs.flatMap((f) => {
    const declared = declaredDependencies(f.dir);
    return f.specs.map((spec) => {
      const parsed = parseSpec(spec);
      return {
        spec,
        parsed,
        declared: Boolean(parsed && declared.has(parsed.name)),
      };
    });
  });
  const unparsable = specs.find((s) => !s.parsed);
  if (unparsable)
    return {
      block:
        `Dependency gate: \`${unparsable.spec}\` is not a plain registry package (a git URL, ` +
        `tarball, path, alias or variable), so it cannot be vetted. ${NEXT_STEP}`,
      log: `unparsable=${unparsable.spec}`,
    };

  const toVet = specs.filter((s) => !s.declared);
  let refused;
  try {
    const verdicts = await Promise.all(
      toVet.map(async (s) => ({
        spec: s.spec,
        reason: refusal(await fetchFacts(s.parsed.name, s.parsed.version)),
      })),
    );
    refused = verdicts.filter((v) => v.reason);
  } catch (e) {
    return {
      block:
        `Dependency gate: could not reach the npm registry to vet ${quoted(toVet.map((s) => s.spec))} ` +
        `(${e.message}). The install is refused rather than run unvetted; retry later, or tell ` +
        "the user that a human has to add this package.",
      log: `registry-error ${e.message}`,
    };
  }
  if (refused.length)
    return {
      block:
        `Dependency gate refused ${refused.map((r) => `\`${r.spec}\` (${r.reason})`).join(", ")}. ` +
        `${POLICY} ${NEXT_STEP}`,
      log: `refused=${refused.map((r) => `${r.spec}:${r.reason}`).join(";")}`,
    };

  const rewrite = installs
    .map((f) => f.insertAt)
    .sort((a, b) => b - a)
    .reduce(
      (cmd, at) => cmd.slice(0, at) + PINNED_FLAGS + cmd.slice(at),
      command,
    );
  const names = (list) => list.map((s) => s.spec).join(",");
  return {
    rewrite,
    log: `vetted=[${names(toVet)}] declared=[${names(specs.filter((s) => s.declared))}]`,
  };
}

export async function check(input, ctx) {
  const decision = await decide(input);
  if (!decision) return;
  if (decision.block) ctx.block({ reason: decision.block, log: decision.log });
  ctx.rewriteInput({ command: decision.rewrite }, { log: decision.log });
}

runStandalone(import.meta.url, "dependency-gate", check);
