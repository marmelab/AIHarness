#!/usr/bin/env node
// PreToolUse(Bash) — any caller. A dev container running docker-in-docker must not let
// the agent launch arbitrary containers. Block commands that create/run/start one
// (`docker run|create|start`, `docker compose up`, `docker-compose up`) unless they
// reference a stack the project declared. Inspection/management verbs (ps, logs, stop,
// rm, exec, …) are never blocked.
//
// The allowed stacks come from harness.config.json `containers.allow`, so the guard
// names no vendor. An unset or empty list blocks every launch, which is the safe
// baseline; a project opts its own stack in (e.g. `{"containers":{"allow":["supabase"]}}`).
// A config that cannot be read blocks too: failing open here would silently hand back
// arbitrary container launches.

import { allowedContainers, loadConfig } from "./lib/config.mjs";
import { runStandalone } from "./lib/hook-chain.mjs";

// A command that brings a container up: `docker [container] run|create|start`,
// or compose `up` (both `docker compose up` and legacy `docker-compose up`).
const launchesContainer = (c) =>
  /\bdocker\s+(container\s+)?(run|create|start)\b/.test(c) ||
  /\bdocker(-compose|\s+compose)\b[^\n]*\bup\b/.test(c);

// A declared stack's own CLI usually drives the Docker daemon directly rather than
// shelling out `docker run`, so it is unaffected either way; this exception covers
// operating its containers by hand.
const referencesAllowedStack = (c, allowed) =>
  allowed.some((name) =>
    new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(c),
  );

export function check(input, ctx) {
  const cmd = input.tool_input?.command || "";
  if (!cmd) return;

  let allowed = [];
  try {
    allowed = allowedContainers(loadConfig());
  } catch {
    allowed = [];
  }

  if (launchesContainer(cmd) && !referencesAllowedStack(cmd, allowed)) {
    ctx.block({
      reason:
        "Docker container launch blocked: this dev container only permits the stacks declared in " +
        `harness.config.json \`containers.allow\` (currently ${allowed.length ? allowed.map((a) => `\`${a}\``).join(", ") : "none"}). ` +
        "`docker run|create|start` and `docker compose up` are disabled for anything else. " +
        "Use the project's documented command to bring the local stack up.",
      log: `cmd=${cmd.slice(0, 120)} allowed=[${allowed.join(",")}]`,
    });
  }
}

runStandalone(import.meta.url, "block-docker-containers", check);
