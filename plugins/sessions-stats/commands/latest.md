---
description: Open the stats page of your latest sessions, every project (--last <n>, --since <age>, --project <text>)
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/run-stats.mjs" --recent $ARGUMENTS`

Above is the output of the stats script for the latest sessions. Reply with its `page:` line, verbatim, and nothing else. If it printed an error instead, quote that error in one line.
