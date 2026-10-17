#!/usr/bin/env bash
# Start/stop a local BijliLog server on port 18431 using a pid file.
set -euo pipefail
cd "$(dirname "$0")/.."
PIDF=evidence/tmp/server.pid; mkdir -p evidence/tmp
case "${1:-start}" in
  stop) [ -f "$PIDF" ] && kill "$(cat "$PIDF")" 2>/dev/null || true; rm -f "$PIDF" ;;
  start)
    "$0" stop
    PORT="${PORT:-18431}" nohup node --env-file=.env.local server/server.mjs > evidence/tmp/server.log 2>&1 &
    echo $! > "$PIDF"; sleep 2; cat evidence/tmp/server.log ;;
esac
