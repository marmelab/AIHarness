---
description: Open the stats page of this session (add --whole to count a harness run's whole session)
allowed-tools: Bash(node:*)
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/run-stats.mjs" --session ${CLAUDE_SESSION_ID} $ARGUMENTS`

Above is the output of the stats script for this session. Reply with its `page:` line, verbatim, and nothing else. If it printed an error instead, quote that error in one line.
