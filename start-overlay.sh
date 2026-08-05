#!/bin/sh
# Launch the Agent Usage Widget with no lingering terminal window.
# Clears ELECTRON_RUN_AS_NODE just in case the parent shell had it set
# (VS Code's remote server and Claude Code's runtime do) — scripts/start.js
# clears it too, but unsetting here avoids a Node-only boot flash.
cd "$(dirname "$0")"
unset ELECTRON_RUN_AS_NODE
exec node scripts/start.js
