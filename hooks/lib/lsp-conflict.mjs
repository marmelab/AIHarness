// Which OTHER enabled plugin has taken the file extensions we declare an LSP server for.
//
// The runtime's rule, documented: when several enabled LSP servers claim the same
// extension, "the first server registered handles files with that extension and the
// others never start". The order is not documented and there is no priority field, so a
// plugin cannot win, yield, or even find out that it lost except through the /plugin UI.
//
// That is not a theoretical hazard. Run 8bfcc2b0 had the LSP tool exposed, the rule
// telling three agents to prefer it, and ZERO calls: the official `typescript-lsp`
// plugin — enabled in the USER's settings, so invisible to anything the project does —
// claimed `.ts` first with a bare `typescript-language-server`, a binary its own README
// says to install globally and nobody had. Every call answered `Executable not found in
// $PATH`, and the agents fell back to grepping in Bash, which is the largest single line
// of a run's tool time.
//
// Renaming our server does not help (measured: the collision is on the EXTENSION, not
// the server name), and neither does declaring a working command. So this module does
// the only thing that is actually available: name the conflicting plugin and the
// one-line remedy, instead of letting the tool degrade in silence.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const read = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

const CONFIG = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");

// enabledPlugins is merged across scopes, later winning, exactly as the runtime merges
// settings. The user scope is the one that matters here: a project can enable a plugin
// it never mentions, which is how the conflict above survived a project-side cleanup.
const enabledPluginIds = (projectDir) => {
  const enabled = {};
  const sources = [
    join(CONFIG, "settings.json"),
    join(projectDir || process.cwd(), ".claude", "settings.json"),
    join(projectDir || process.cwd(), ".claude", "settings.local.json"),
  ];
  for (const path of sources) {
    const settings = read(path);
    Object.assign(enabled, (settings && settings.enabledPlugins) || {});
  }
  return new Set(
    Object.entries(enabled)
      .filter(([, on]) => on)
      .map(([id]) => id),
  );
};

// A plugin declares its servers either in its own manifest or, for a marketplace entry,
// in the marketplace file. Both are checked because the official plugins use the second
// form and ship no manifest of their own.
const declaredServers = (id) => {
  const [name, marketplace] = id.split("@");
  if (!name || !marketplace) return {};

  const entry = (
    (
      read(
        join(
          CONFIG,
          "plugins",
          "marketplaces",
          marketplace,
          ".claude-plugin",
          "marketplace.json",
        ),
      ) || {}
    ).plugins || []
  ).find((p) => p && p.name === name);
  if (entry && entry.lspServers) return entry.lspServers;

  const cacheDir = join(CONFIG, "plugins", "cache", marketplace, name);
  let versions = [];
  try {
    versions = readdirSync(cacheDir).sort();
  } catch {
    return {};
  }
  for (const version of versions.reverse()) {
    const manifest = join(cacheDir, version, ".claude-plugin", "plugin.json");
    if (!existsSync(manifest)) continue;
    const plugin = read(manifest);
    if (plugin && plugin.lspServers) return plugin.lspServers;
  }
  return {};
};

const extensionsOf = (servers) => {
  const out = new Set();
  for (const cfg of Object.values(servers || {}))
    for (const ext of Object.keys((cfg && cfg.extensionToLanguage) || {}))
      out.add(ext);
  return out;
};

/**
 * Other enabled plugins claiming any extension this plugin's servers declare.
 *
 * @param {Record<string, unknown>} ourServers  This plugin's `lspServers` block.
 * @param {string} [projectDir]  Repo root, for the project-scope settings files.
 * @param {string} [selfId]  This plugin's `name@marketplace`, excluded from the scan.
 * @returns {Array<{ id: string, extensions: string[] }>}
 */
export function lspConflicts(
  ourServers,
  projectDir,
  selfId = "aiharness@aiharness",
) {
  const ours = extensionsOf(ourServers);
  if (!ours.size) return [];
  const conflicts = [];
  for (const id of enabledPluginIds(projectDir)) {
    if (id === selfId) continue;
    const shared = [...extensionsOf(declaredServers(id))].filter((e) =>
      ours.has(e),
    );
    if (shared.length) conflicts.push({ id, extensions: shared.sort() });
  }
  return conflicts;
}

/**
 * One line per conflict, saying what to do about it.
 *
 * @param {Array<{ id: string, extensions: string[] }>} conflicts
 * @returns {string}  "" when there is nothing to say.
 */
export function conflictReport(conflicts) {
  return conflicts
    .map(
      ({ id, extensions }) =>
        `LSP conflict: the enabled plugin \`${id}\` also claims ${extensions.join(", ")}. ` +
        `Only one server starts and the order is undefined, so the LSP tool may fail with ` +
        `"Executable not found in $PATH" and every agent will fall back to grep. ` +
        `Disable \`${id}\` (set it to false in enabledPlugins, user scope included), ` +
        `or install the binary it expects.`,
    )
    .join("\n");
}
