#!/bin/bash
# Publishes the static UI, JSON snapshots of the endpoints it reads, and live.json (current tunnel URL) to
# GitHub Pages: one force-pushed commit on gh-pages, built in a separate folder so the working tree is never touched.
# Env: API (default http://localhost:3300), METRICS (cloudflared metrics address), OUT, REMOTE.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
API=${API:-http://localhost:3300}
METRICS=${METRICS:-localhost:20241}
OUT=${OUT:-$ROOT/.scratch/pages}
REMOTE=${REMOTE:-git@github.com:omreor/litmus.git}

rm -rf "$OUT" && mkdir -p "$OUT/data"
bun build "$ROOT/web/index.html" --outdir "$OUT" --minify >/dev/null
touch "$OUT/.nojekyll"

host=$(curl -sf --max-time 5 "$METRICS/quicktunnel" | jq -r '.hostname // empty' || true)
jq -n --arg host "$host" '{url: (if $host == "" then null else "https://\($host)" end), at: (now | floor)}' > "$OUT/live.json"

# Same naming as apiUrl() in web/hooks.ts: /api/templates?window=3600&organic=1 -> data/templates_window_3600_organic_1.json
export_route() {
  local name=${1#/api/}
  name=${name//[\/?&=]/_}
  curl -sf --max-time 120 "$API$1" -o "$OUT/data/$name.json" || { echo "miss $1"; rm -f "$OUT/data/$name.json"; }
}

routes=(/api/health /api/pools/hot /api/integrity/monthly /api/integrity/postgrad /api/rules "/api/graduations/recent?limit=50" /api/usage
  "/api/benchmarks/similar?quote=SOL&threshold=85")
for w in 3600 21600 86400 604800 2592000; do
  routes+=("/api/overview?window=$w" "/api/launchpads?window=$w" "/api/templates?window=$w" "/api/templates?window=$w&organic=1")
done
for route in "${routes[@]}"; do export_route "$route"; done
# Details for every template the exported lists show.
for id in $(cat "$OUT"/data/templates_window_*.json 2>/dev/null | jq -r '.[].template' | sort -u); do export_route "/api/templates/$id"; done

if grep -rqE 'api_key=|sk_[A-Za-z0-9]{16,}' "$OUT"; then
  echo "secret-looking string in $OUT, not publishing" >&2
  exit 1
fi

cd "$OUT"
git init -q -b gh-pages
git add -A
git commit -qm "snapshot $(date -u +%FT%TZ)"
git push -qf "$REMOTE" HEAD:gh-pages
echo "published $(ls data | wc -l | tr -d ' ') snapshots, live url: ${host:-none}"
