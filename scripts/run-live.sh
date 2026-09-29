#!/bin/bash
# Serves Litmus live from this machine: the API server, a Cloudflare quick tunnel to it, caffeinate, and a
# publisher that runs scripts/publish.sh every 15 minutes (and within a minute of the tunnel URL changing).
# Each process restarts when it exits. Re-running replaces a previous run; `scripts/run-live.sh stop` stops it.
# Logs and pids: .scratch/live/. Env: PORT (3300), DB_PATH (.scratch/history.sqlite), CLOUDFLARED.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
DIR=$ROOT/.scratch/live
PORT=${PORT:-3300}
METRICS=localhost:20241
export DB_PATH=${DB_PATH:-$ROOT/.scratch/history.sqlite}
CLOUDFLARED=${CLOUDFLARED:-$(command -v cloudflared || echo "$ROOT/.scratch/bin/cloudflared")}
mkdir -p "$DIR"
cd "$ROOT"

# Kills each supervisor loop, then the process it was running (collected first: they outlive the loop).
for pidfile in "$DIR"/*.pid; do
  [ -e "$pidfile" ] || continue
  pid=$(cat "$pidfile")
  kids=$(pgrep -P "$pid" || true)
  kill "$pid" $kids 2>/dev/null || true
  rm -f "$pidfile"
done
[ "${1:-}" = stop ] && { echo "stopped"; exit 0; }
[ -x "$CLOUDFLARED" ] || { echo "cloudflared not found (set CLOUDFLARED)" >&2; exit 1; }

# Runs a command forever under nohup, restarting it 5 s after it exits.
supervise() {
  local name=$1
  shift
  nohup bash -c 'while true; do "$@"; echo "$(date -u +%FT%TZ) exited with $?, restarting"; sleep 5; done' _ "$@" >> "$DIR/$name.log" 2>&1 &
  echo $! > "$DIR/$name.pid"
}

supervise caffeinate caffeinate -is
supervise server env PORT="$PORT" bun src/server.ts
supervise tunnel "$CLOUDFLARED" tunnel --url "http://localhost:$PORT" --metrics "$METRICS" --no-autoupdate
supervise publisher bash -c '
  sleep 90
  last= next=0
  while true; do
    host=$(curl -sf --max-time 5 '"$METRICS"'/quicktunnel | jq -r ".hostname // empty" || true)
    if [ "$host" != "$last" ] || [ "$(date +%s)" -ge "$next" ]; then
      echo "$(date -u +%FT%TZ) publishing"
      scripts/publish.sh && last=$host && next=$(( $(date +%s) + 900 ))
    fi
    sleep 60
  done'
echo "started: server :$PORT, tunnel, caffeinate, publisher. Logs in $DIR"
