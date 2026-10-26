#!/usr/bin/env bash
# Verifies that sqlite/ and postgres/ migration directories are paired:
# same numbering, same filenames, and the same set of CREATE TABLE names.
# Read-only; modeled on the growth-os / job-agent dual-dialect convention.
set -euo pipefail

cd "$(dirname "$0")/.."
SQL_DIR="db/migrations/sqlite"
PG_DIR="db/migrations/postgres"

fail=0

sql_files=$(find "$SQL_DIR" -name '*.sql' -exec basename {} \; | sort)
pg_files=$(find "$PG_DIR" -name '*.sql' -exec basename {} \; | sort)

if [ "$sql_files" != "$pg_files" ]; then
  echo "FAIL: migration filenames are not paired between sqlite/ and postgres/"
  diff <(echo "$sql_files") <(echo "$pg_files") || true
  fail=1
fi

for f in $sql_files; do
  sql_tables=$(grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+' "$SQL_DIR/$f" | awk '{print $NF}' | sort || true)
  pg_tables=$(grep -oE 'CREATE TABLE IF NOT EXISTS [a-z_]+' "$PG_DIR/$f" | awk '{print $NF}' | sort || true)
  if [ "$sql_tables" != "$pg_tables" ]; then
    echo "FAIL: table set mismatch in $f"
    diff <(echo "$sql_tables") <(echo "$pg_tables") || true
    fail=1
  fi
done

if [ "$fail" -ne 0 ]; then
  exit 1
fi
# Count files directly from disk: `echo "$empty" | wc -l` reports 1 for an
# empty string, which would print "1 files each" on a fresh scaffold.
file_count=$(find "$SQL_DIR" -name '*.sql' | wc -l | tr -d ' ')
echo "OK: paired migrations ($file_count files each, sqlite + postgres)"
