#!/bin/sh
# Daily pg_dump sidecar for the growth-agent stack (design §7: pg_dump daily,
# 7-day retention; aligned with the loom db-backup pattern). Runs inside the
# pgvector/pgvector:pg16 image (pg_dump + psql present).
#
# Required env: PGHOST PGUSER PGPASSWORD PGDATABASE
# Optional:     BACKUP_INTERVAL_SECONDS (86400) RETENTION_DAYS (7)
set -eu

: "${PGHOST:?PGHOST required}"
: "${PGUSER:?PGUSER required}"
: "${PGPASSWORD:?PGPASSWORD required}"
: "${PGDATABASE:?PGDATABASE required}"

BACKUP_DIR=/backups
INTERVAL="${BACKUP_INTERVAL_SECONDS:-86400}"
RETENTION_DAYS="${RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_DIR"

backup_once() {
  ts="$(date -u +%Y%m%dT%H%M%SZ)"
  out="$BACKUP_DIR/${PGDATABASE}-${ts}.sql.gz"
  echo "[pg-backup] dumping $PGDATABASE @ $PGHOST -> $out"
  # --no-owner keeps the dump portable across the ephemeral container uid.
  if pg_dump --no-owner --clean --if-exists "$PGDATABASE" | gzip > "$out.tmp"; then
    mv "$out.tmp" "$out"
  else
    echo "[pg-backup] FAILED dump at $ts" >&2
    rm -f "$out.tmp"
    return 1
  fi
  # Retention: delete dumps older than RETENTION_DAYS days.
  find "$BACKUP_DIR" -name "${PGDATABASE}-*.sql.gz" -type f -mtime "+$RETENTION_DAYS" -delete
}

while true; do
  # Wait for postgres (depends_on health covers ordering, but keep the loop
  # resilient to a restarted database container).
  if pg_isready -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" >/dev/null 2>&1; then
    backup_once || true
  else
    echo "[pg-backup] postgres not ready, retrying next interval" >&2
  fi
  sleep "$INTERVAL"
done
