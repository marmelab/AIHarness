# sessions-stats

Where a Claude Code session's minutes, tokens and dollars went, agent by agent, as one
self-contained HTML page.

It reads the transcripts Claude Code already writes under `~/.claude/projects` for every
session, so it works in any project, with or without the `aiharness` plugin. It ships
commands only: no hook, nothing running in the background.

## Install

```
/plugin marketplace add marmelab/AIHarness
/plugin install sessions-stats@aiharness
```

Install it at user scope to have it in every project. It is independent of `aiharness`:
installing one does not enable the other.

## Your latest sessions

`/sessions-stats:latest` opens one page holding your 25 latest sessions across every
project, the last written first, with a selector to move between them:

```
/sessions-stats:latest                     # the 25 latest
/sessions-stats:latest --last 50
/sessions-stats:latest --since 3d          # every session written in the last three days
/sessions-stats:latest --project atomic    # projects whose transcript directory matches
```

A session with no model turn yet does not take a place. Projects under the tmp dir (test
fixtures, throwaway probes) are left out unless `--project` names them.

It reads what Claude Code still holds, so it reaches back as far as `cleanupPeriodDays`
(30 days by default) and no further. 25 sessions take about five seconds.

## This session

`/sessions-stats:stat` opens the page of the session you are in. `--whole` also counts, in a
harness run, your own work before the first harness agent started.

Both commands run their script before the model sees anything; the model's one short turn
only relays the link.

## What it leaves on disk

One HTML page per report, under the system tmp dir (`$SESSIONS_STATS_TMP_ROOT` overrides it):
around 10 MB for 25 sessions. The SQLite store the page is built from is deleted once
the page is written, and pages older than a day are swept by the next report. Nothing is
written in the project.

## From a keyboard shortcut

A shortcut does the same with no model turn. For `stat` it cannot know which session is
yours, so it takes the project's session that wrote last; add `--recent` to the command
for the latest sessions instead. In VS Code, add a user task (`Tasks: Open User Tasks`):

```json
{
  "label": "Session stats",
  "type": "shell",
  "command": "node ~/.claude/plugins/marketplaces/aiharness/plugins/sessions-stats/scripts/run-stats.mjs",
  "options": { "cwd": "${workspaceFolder}" },
  "presentation": { "reveal": "silent" }
}
```

and bind it in `keybindings.json`:

```json
{
  "key": "ctrl+alt+s",
  "command": "workbench.action.tasks.runTask",
  "args": "Session stats"
}
```

## Keeping runs, comparing them

Claude Code deletes transcripts after `cleanupPeriodDays`. To keep a run past that, or to
compare two arms of the same task, `/sessions-stats:report` walks through the three steps:
`run-archive.mjs` copies the raw transcripts to `<project>/.runs/archive`, `run-ingest.mjs`
derives a SQLite store from them, `run-report.mjs` renders it. `run-compare.mjs` then puts
two tagged arms side by side.

## Before sharing a page

The page embeds the session's real data: every shell command in full, absolute file paths,
agent descriptions, the names of the instruction files that were injected. Fine for an
internal channel or a private Artifact; for anything public, render it with
`run-report.mjs --redact`, which keeps every figure and drops the text behind them.

## Working on it

It lives in the AIHarness repository and its tests run with that repo's `npm test`.

Claude Code installs a plugin by copying its directory, so nothing here may import from
outside `plugins/sessions-stats/`; a test enforces it. `scripts/lib/bash-classify.mjs` and
`scripts/lib/pricing.mjs` are verbatim copies of the harness's own, which another test
keeps identical: change both or neither.
