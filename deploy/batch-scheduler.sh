#!/bin/sh
# Batch scheduler sidecar for the growth-agent stack (design §5 cadence).
# Runs inside the growth-agent image, which has no cron daemon, so this follows
# the same sleep-loop pattern as deploy/pg-backup.sh.
#
# Each tick runs, in order:
#   daily      morning batch: candidates -> zeus D2 human review
#   production approved (drafting) tasks -> QA gates -> open a PR (never merge)
#   verify     next-day GSC recheck of merged tasks
#   health     last 30 complete days must each have a successful run
#
# The health step is the continuity alarm (#10): any missed day or day with no
# successful run exits 1 on the same tick, so `docker compose logs batch` and
# `docker compose ps` show the gap the day it happens instead of thirty days
# later. It only reads the run ledger on the reports volume; it never writes.
#
# All three batch steps are safe to run every tick: `daily` is guarded by
# same-day idempotency, `verify` by an already-checked-today guard, and
# `production` only acts on tasks a human has approved. A tick that finds
# nothing is a no-op. `health` is read-only.
#
# `report` and `packet` are deliberately NOT in the loop: writeWeeklyReport and
# writeDogfoodPacket version their output instead of overwriting it, so an
# hourly tick would litter the report volume. Invoke them on their own schedule
# (see deploy/SELF_HOSTING.md).
#
# Required env: BATCH_SITE (site id from config/sites/*.json)
# Optional:     BATCH_INTERVAL_SECONDS (3600)  BATCH_DAILY_HOUR_UTC (6)
set -eu

: "${BATCH_SITE:?BATCH_SITE required (site id from config/sites/*.json)}"

INTERVAL="${BATCH_INTERVAL_SECONDS:-3600}"
DAILY_HOUR="${BATCH_DAILY_HOUR_UTC:-6}"
NODE_FLAGS="--experimental-sqlite"
BATCH="dist/cli/batch.js"

run_step() {
  step="$1"
  echo "[batch] $(date -u +%Y-%m-%dT%H:%M:%SZ) running $step for $BATCH_SITE"
  # A failed step must not kill the loop: report it and continue so the next
  # tick retries. The exit status has to be captured on the same command line —
  # after an `if !` wrapper $? belongs to the test, not to node.
  status=0
  node $NODE_FLAGS "$BATCH" "$step" --site "$BATCH_SITE" || status=$?
  if [ "$status" -ne 0 ]; then
    echo "[batch] step $step FAILED (exit $status)" >&2
  fi
}

while true; do
  hour="$(date -u +%H)"
  # §5.A schedules the morning batch at 06:00 UTC; the same-day idempotency
  # guard inside DailyScriptRunner makes the rest of the day's ticks no-ops.
  if [ "$hour" -ge "$DAILY_HOUR" ]; then
    run_step daily
  else
    echo "[batch] $(date -u +%Y-%m-%dT%H:%M:%SZ) before ${DAILY_HOUR}:00 UTC, skipping daily"
  fi
  run_step production
  run_step verify
  # A gap is logged by run_step above; it must not stop the loop, because the
  # next tick can still cover the day.
  run_step health
  sleep "$INTERVAL"
done
