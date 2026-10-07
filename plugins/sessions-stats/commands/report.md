---
description: Build the stats report for a session, from its own transcripts
---

Turn a Claude Code session's transcripts into one self-contained HTML page that says where its minutes and its tokens went. This is **read-only**: it reads transcripts and writes one file.

It works on **any** session, not only a harness run. A session with no subagent at all is reported the same way, with one agent instead of twenty-five.

### 1. Archive the transcripts before they are pruned

Claude Code removes them after `cleanupPeriodDays` (30 by default), so the archive is what makes a run re-analysable later. Skip this step only if the session is already archived.

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/run-archive.mjs --list
node ${CLAUDE_PLUGIN_ROOT}/scripts/run-archive.mjs --slug <project-slug>
```

`--list` prints the slugs with their session counts. The slug of the current project is its root path with `/` replaced by `-`.

### 2. Derive the store

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/run-ingest.mjs --all
```

Idempotent per session, so re-running costs nothing and re-deriving the whole archive after an upgrade is the same command.

### 3. Build the page

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/run-report.mjs
```

Useful flags:

| Flag                | Effect                                                  |
| ------------------- | ------------------------------------------------------- |
| `--sessions <id,…>` | report these sessions instead of the twelve richest     |
| `--out <file>`      | where to write the page (default `.runs/report.html`)   |
| `--redact`          | drop commands, paths and prompts; keep every aggregate  |
| `--limit <n>`       | how many sessions to detail when `--sessions` is absent |

Then tell the user the path, and offer to open it.

### Before sharing it

**The page embeds the session's real data**: every shell command in full, absolute file paths, agent descriptions and the names of the instruction files that were injected. That is what makes the drill-downs worth having, and it is also what makes the page unfit for anywhere public.

- internal Slack, a private CI artifact, a private Artifact: fine.
- a public repository, GitHub Pages, an issue: **use `--redact`**, which keeps every figure and every chart and removes the text behind them.

If the user asks for a shareable link, publish it as an Artifact, which is private by default, and say so.
