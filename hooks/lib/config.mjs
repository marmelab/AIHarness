// harness.config.json loader: the single project-facts manifest consumed by
// hooks/scripts at runtime (and by the renderer at sync time in a later phase).
// Stdlib only. Fail-closed on a malformed config (throws a clear Error); a
// MISSING file degrades to the built-in defaults so a config-less repo still
// runs a minimal harness.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./paths.mjs";

export const CONFIG_FILENAME = "harness.config.json";

// Minimal safe baseline. The committed harness.config.json overrides these.
// Optional capabilities (deploy, app) are ABSENT here on purpose: a capability
// exists iff its block is present in the config.
const DEFAULTS = {
  name: "harness",
  layout: { src: "src", e2e: "e2e", adr: "adr" },
  // Container images the agent may bring up. Empty = block every launch, the safe
  // baseline: a project declares its own stack (e.g. ["supabase"]) instead of the guard
  // hardcoding one vendor.
  containers: { allow: [] },
  validation: { steps: [], extraForbidden: [] },
  worktree: { provision: "npm-link" },
  skills: { developerMenu: [] },
  roles: {},
  launcher: {
    sessionDirEnv: "CHAT_SESSION_DIR",
    turnSentinelDir: null,
    postCheckoutScript: null,
    logsDir: null,
  },
};

const isObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v);

// Deep-merge `override` onto `base`. Objects merge recursively; arrays and
// scalars from `override` REPLACE (never concatenate): a config that lists
// validation.steps fully replaces the default empty list.
function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) return override;
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isObject(v) && isObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

class ConfigError extends Error {}

// Throw a clear, prefixed error so a fail-closed consumer surfaces exactly what
// is wrong with the config.
function fail(msg) {
  throw new ConfigError(`${CONFIG_FILENAME}: ${msg}`);
}

function validate(cfg) {
  if (!isObject(cfg)) fail("top level must be a JSON object");

  if (!isObject(cfg.validation) || !Array.isArray(cfg.validation.steps)) {
    fail("`validation.steps` must be an array");
  }
  for (const [i, step] of cfg.validation.steps.entries()) {
    if (!isObject(step)) fail(`validation.steps[${i}] must be an object`);
    if (typeof step.id !== "string" || !step.id) {
      fail(`validation.steps[${i}] needs a non-empty string \`id\``);
    }
    if (typeof step.kind !== "string" || !step.kind) {
      fail(`validation.steps[${step.id}] needs a non-empty string \`kind\``);
    }
    const isVitest = step.runner === "vitest";
    if (!isVitest && (typeof step.command !== "string" || !step.command)) {
      fail(
        `validation.steps[${step.id}] needs a \`command\` (or runner:"vitest")`,
      );
    }
    if (
      isVitest &&
      (typeof step.config !== "string" || !Array.isArray(step.projects))
    ) {
      fail(
        `validation.steps[${step.id}] (vitest) needs \`config\` and \`projects[]\``,
      );
    }
  }

  if (!isObject(cfg.roles)) fail("`roles` must be an object");
  for (const [name, role] of Object.entries(cfg.roles)) {
    if (!isObject(role) || typeof role.model !== "string" || !role.model) {
      fail(`roles.${name} needs a non-empty string \`model\``);
    }
  }

  if ("deploy" in cfg && cfg.deploy !== undefined) {
    if (!isObject(cfg.deploy) || !Array.isArray(cfg.deploy.relevantGlobs)) {
      fail("`deploy.relevantGlobs` must be an array when `deploy` is present");
    }
  }
  return cfg;
}

const cache = new Map();

/**
 * Load and validate the harness config, merged over the defaults.
 * @param {string} [repo] repo root holding harness.config.json (defaults to REPO)
 * @returns {object} the validated, merged config
 * @throws {Error} on malformed JSON or an invalid shape (fail-closed)
 */
export function loadConfig(repo = REPO) {
  if (cache.has(repo)) return cache.get(repo);
  const path = join(repo, CONFIG_FILENAME);
  let merged;
  if (!existsSync(path)) {
    merged = validate(structuredClone(DEFAULTS));
  } else {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      fail(`invalid JSON (${e.message})`);
    }
    merged = validate(deepMerge(DEFAULTS, parsed));
  }
  cache.set(repo, merged);
  return merged;
}

// Test-only: drop the memoized config so a test can reload after writing a new
// file to the same repo path.
export function clearConfigCache() {
  cache.clear();
}

// ---- Typed readers used by the config consumers ----------------

export const validationSteps = (cfg) => cfg.validation?.steps ?? [];
export const extraForbidden = (cfg) => cfg.validation?.extraForbidden ?? [];
export const isDeployEnabled = (cfg) => isObject(cfg.deploy);
export const deployGlobs = (cfg) => cfg.deploy?.relevantGlobs ?? [];
export const isAppSmokeEnabled = (cfg) => isObject(cfg.app);
export const worktreeProvision = (cfg) => cfg.worktree?.provision ?? "npm-link";
export const roleNames = (cfg) => Object.keys(cfg.roles ?? {});
export const roleModel = (cfg, role) => cfg.roles?.[role]?.model ?? "";
export const pipelineRoles = (cfg) =>
  roleNames(cfg).filter((r) => cfg.roles[r]?.pipeline);
export const debounceRoles = (cfg) =>
  roleNames(cfg).filter((r) => cfg.roles[r]?.debounce);
// Roles whose stop runs the validation chain, i.e. the roles that write code in a
// worktree. Every other stop is not validation's business: a reviewer, merger, planner or
// orchestrator owns no worktree, so there is nothing there to validate.
export const validateRoles = (cfg) =>
  roleNames(cfg).filter((r) => cfg.roles[r]?.validate);
// Managed-launcher extension points (empty object when no launcher overlay).
export const launcher = (cfg) => cfg.launcher ?? {};
// The env var carrying the managed launcher's session dir. A launcher that uses a
// different name declares it as config.launcher.sessionDirEnv.
export const sessionDirEnvName = (cfg) =>
  cfg.launcher?.sessionDirEnv || DEFAULTS.launcher.sessionDirEnv;

/**
 * The managed launcher's session dir, or "" when there is no managed launcher.
 *
 * The ONE place that env var is read. Every consumer used to read
 * process.env.CHAT_SESSION_DIR directly, which made config.launcher.sessionDirEnv a
 * documented extension point that changed nothing: under a launcher exporting any
 * other name, the review verdict flags, the e2e result and the status board were
 * written to and read from the recomputed /tmp/<repo>/<id> path instead of the dir
 * the launcher owns. Nothing errors in that state; the verdicts are simply not where
 * anyone looks for them.
 *
 * @param {object} [cfg] a config already loaded by the caller
 * @returns {string}
 */
export function sessionDirFromEnv(cfg) {
  let name;
  try {
    name = sessionDirEnvName(cfg ?? loadConfig());
  } catch {
    name = DEFAULTS.launcher.sessionDirEnv;
  }
  return process.env[name] || "";
}
export const allowedContainers = (cfg) => cfg.containers?.allow ?? [];
// The format-kind validation step (null when none), used by format-on-write.
export const formatStep = (cfg) =>
  validationSteps(cfg).find((s) => s.kind === "format") ?? null;
// Steps a pre-PR / pre-push gate runs on the human path (fast checks only).
// `changedScoped` steps are EXCLUDED: they need a per-worktree diff base (the
// session branch) that the human push path lacks, and running their bare command
// whole-repo would lint/test far more than the change at hand.
export const prePrSteps = (cfg) =>
  validationSteps(cfg).filter(
    (s) => (s.kind === "typecheck" || s.kind === "lint") && !s.changedScoped,
  );
