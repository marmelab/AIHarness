#!/usr/bin/env node
// Does the configured LSP server actually START?
//
// `rules/lsp-usage.md` tells the developer, the reviewer and the planner to resolve
// symbols through the LSP tool instead of grepping for them, and every one of those
// agents lists `LSP` in its frontmatter. Across two full runs the tool was used exactly
// ZERO times, and the reason was not a prompt: `typescript-language-server` was not
// installed, not on PATH and not in node_modules, so the tool's server could never start.
// The plugin the project had enabled for it ships no binary either; its README says to
// install one globally, which nobody had.
//
// Nothing failed. The agents simply fell back to `grep` in Bash, which is the single
// largest line of a run's tool time, and the rule telling them not to had no way to
// take effect. That is the failure mode this check exists to make loud: a capability
// that degrades into "the expensive way" reports nothing on its own.
//
// Run by `npm run check`. Exits 0 when the server answers, 1 when it does not, so CI and
// a human both learn the same thing.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const manifest = join(HERE, "..", ".claude-plugin", "plugin.json");

const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const plugin = read(manifest);
const servers = (plugin && plugin.lspServers) || {};
const names = Object.keys(servers);

if (!names.length) {
  console.log("check-lsp-server: no lspServers declared, nothing to verify");
  process.exit(0);
}

let failed = 0;
for (const name of names) {
  const { command, args = [] } = servers[name] || {};
  if (!command) {
    console.error(`check-lsp-server: ${name} declares no command`);
    failed++;
    continue;
  }

  // `--version` rather than a real LSP handshake: it answers in under a second, needs no
  // stdio protocol, and fails for the one reason that matters here, the binary not being
  // resolvable at all. `--stdio` is dropped for the probe, since it would wait for a
  // client that is not coming.
  const probeArgs = args.filter((a) => a !== "--stdio").concat("--version");
  const r = spawnSync(command, probeArgs, {
    encoding: "utf8",
    timeout: 120000,
  });

  if (r.error || r.status !== 0) {
    const why = r.error
      ? r.error.code === "ENOENT"
        ? `\`${command}\` is not on PATH`
        : String(r.error.message).slice(0, 120)
      : `exit ${r.status}`;
    console.error(
      `check-lsp-server: FAIL ${name} (${command} ${probeArgs.join(" ")}): ${why}\n` +
        `  Every agent that lists the LSP tool will silently fall back to grepping in Bash.`,
    );
    failed++;
    continue;
  }
  console.log(
    `check-lsp-server: OK ${name} -> ${
      String(r.stdout || r.stderr)
        .trim()
        .split("\n")[0]
    }`,
  );
}

// A project may also declare its own server. When it does and the two disagree, the one
// that wins is not something this script can decide, so it only reports the divergence:
// two declarations pointing at different commands is how the broken one survived.
const projectSettings = read(
  join(
    process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    ".claude",
    "settings.json",
  ),
);
for (const [name, cfg] of Object.entries(
  (projectSettings && projectSettings.lspServers) || {},
)) {
  const mine = servers[name];
  if (mine && cfg && cfg.command !== mine.command) {
    console.error(
      `check-lsp-server: NOTE the project also declares ${name} as \`${cfg.command}\`, ` +
        `where this plugin declares \`${mine.command}\`. Make them agree, or drop one: ` +
        `a stale project entry pointing at an uninstalled binary is what disabled the tool.`,
    );
  }
}

process.exit(failed ? 1 : 0);
