#!/bin/sh
# Dogfood smoke (T-H2): builds the project, boots the real orchestrator
# process in fully-offline mode (ephemeral sqlite), asserts /healthz reports
# ready, then runs the offline end-to-end pipeline smoke (daily -> zeus
# human approval -> QA -> PR -> merge -> verification -> reports).
# No external network, no real credentials, no persistent data.
set -eu

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PORT="${SMOKE_PORT:-8791}"

echo "==> build"
npm run build

TMPD="$(mktemp -d)"
cleanup() {
  [ -n "${SRV_PID:-}" ] && kill "$SRV_PID" 2>/dev/null || true
  rm -rf "$TMPD"
}
trap cleanup EXIT

echo "==> boot orchestrator (offline, port $PORT)"
GA_SQLITE_PATH="$TMPD/ga.db" \
GA_REPORT_DIR="$TMPD/reports" \
GA_GSC_TOKEN_DIR="$TMPD/tokens" \
GA_PORT="$PORT" \
  node --experimental-sqlite dist/serve.js >"$TMPD/serve.log" 2>&1 &
SRV_PID=$!

ready=""
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PORT/healthz" >"$TMPD/healthz.json" 2>/dev/null; then
    ready="yes"
    break
  fi
  sleep 1
done
if [ "$ready" != "yes" ]; then
  echo "server did not become ready; log:" >&2
  cat "$TMPD/serve.log" >&2
  exit 1
fi
grep -q '"status":"ready"' "$TMPD/healthz.json" || {
  echo "healthz did not report ready:" >&2
  cat "$TMPD/healthz.json" >&2
  exit 1
}
echo "==> /healthz ready"

echo "==> offline pipeline smoke"
node scripts/smoke/offline-smoke.mjs
