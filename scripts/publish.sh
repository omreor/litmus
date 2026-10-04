#!/bin/bash
# Publishes the static UI, JSON snapshots of the endpoints it reads, token metadata of Studio launches
# (data/meta/<mint>.json, the URI those tokens carry on-chain) and live.json (current tunnel URL) to GitHub
# Pages: one force-pushed commit on gh-pages, built in a separate folder so the working tree is never touched.
# `scripts/publish.sh meta` republishes the last snapshot with fresh token metadata only (seconds, not a
# minute): the server runs it as soon as it prepares a Studio launch.
# Env: API (default http://localhost:3300), DB_PATH, LIVE_URL (fixed public API URL; else the tunnel's, read from
# METRICS, the cloudflared metrics address), OUT, REMOTE, SOLAMI_API_KEY.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
API=${API:-http://localhost:3300}
DB_PATH=${DB_PATH:-$ROOT/.scratch/history.sqlite}
METRICS=${METRICS:-localhost:20241}
OUT=${OUT:-$ROOT/.scratch/pages}
REMOTE=${REMOTE:-git@github.com:omreor/litmus.git}
KEY=${SOLAMI_API_KEY:-$(sed -n 's/^SOLAMI_API_KEY=//p' "$ROOT/.env" 2>/dev/null || true)}

# The publisher loop and the server's metadata publishes share $OUT: one at a time. A lock older than
# 10 minutes belongs to a publish that died.
lock() {
  until mkdir "$OUT.lock" 2>/dev/null; do
    [ -n "$(find "$OUT.lock" -maxdepth 0 -mmin +10 2>/dev/null)" ] && rm -rf "$OUT.lock"
    sleep 1
  done
  trap 'rm -rf "$OUT.lock"' EXIT
}

# Token metadata straight from the database (mints are base58, safe as file names), then one commit.
push() {
  mkdir -p "$OUT/data/meta"
  sqlite3 -separator ' ' "$DB_PATH" "SELECT mint, json FROM token_meta" | while read -r mint json; do
    printf '%s\n' "$json" > "$OUT/data/meta/$mint.json"
  done
  # The API key is the one secret this machine holds; token names and metadata are user input, so match
  # the key itself rather than key-like patterns anyone could put in a name.
  if [ -n "$KEY" ] && grep -rqF --exclude-dir=.git -e "$KEY" "$OUT"; then
    echo "API key found in $OUT, not publishing" >&2
    exit 1
  fi
  cd "$OUT"
  rm -rf .git
  git init -q -b gh-pages
  git add -A
  git commit -qm "$1"
  git push -qf "$REMOTE" HEAD:gh-pages
}

if [ "${1:-}" = meta ]; then
  lock
  [ -f "$OUT/index.html" ] || { echo "no previous publish in $OUT" >&2; exit 1; }
  push "token metadata $(date -u +%FT%TZ)"
  echo "published $(ls "$OUT/data/meta" | wc -l | tr -d ' ') token metadata files"
  exit 0
fi

BUILD=$OUT.next
rm -rf "$BUILD" && mkdir -p "$BUILD/data"
bun build "$ROOT/web/index.html" --outdir "$BUILD" --minify >/dev/null
touch "$BUILD/.nojekyll"

url=${LIVE_URL:-}
if [ -z "$url" ]; then
  host=$(curl -sf --max-time 5 "$METRICS/quicktunnel" | jq -r '.hostname // empty' || true)
  [ -n "$host" ] && url=https://$host
fi
jq -n --arg url "$url" '{url: (if $url == "" then null else $url end), at: (now | floor)}' > "$BUILD/live.json"

# Same naming as apiUrl() in web/hooks.ts: /api/templates?window=3600&organic=1 -> data/templates_window_3600_organic_1.json
export_route() {
  local name=${1#/api/}
  name=${name//[\/?&=]/_}
  curl -sf --max-time 120 -A litmus-publisher "$API$1" -o "$BUILD/data/$name.json" || { echo "miss $1"; rm -f "$BUILD/data/$name.json"; }
}

routes=(/api/health /api/pools/hot /api/integrity/monthly /api/integrity/postgrad /api/rules "/api/graduations/recent?limit=50" /api/usage
  "/api/benchmarks/similar?quote=SOL&threshold=85")
for w in 3600 21600 86400 604800 2592000; do
  routes+=("/api/overview?window=$w" "/api/launchpads?window=$w" "/api/templates?window=$w" "/api/templates?window=$w&organic=1")
done
for route in "${routes[@]}"; do export_route "$route"; done
# Details for every template the exported lists show.
for id in $(cat "$BUILD"/data/templates_window_*.json 2>/dev/null | jq -r '.[].template' | sort -u); do export_route "/api/templates/$id"; done

lock
rm -rf "$OUT" && mv "$BUILD" "$OUT"
push "snapshot $(date -u +%FT%TZ)"
echo "published $(ls data/*.json | wc -l | tr -d ' ') snapshots, live url: ${url:-none}"
