#!/usr/bin/env bash
set -euo pipefail
: "${BACKUP_SSH_TARGET:?Set the SSH backup host}"
: "${BACKUP_REMOTE_FILE:?Set the full remote dump path}"
: "${RESTORE_DATABASE:?Set a new database name ending in _restore_test}"
[[ "$BACKUP_SSH_TARGET" =~ ^[a-zA-Z0-9_.@-]+$ ]] || exit 2
[[ "$BACKUP_REMOTE_FILE" =~ ^/[a-zA-Z0-9_./-]+\.dump$ ]] || exit 2
[[ "$BACKUP_REMOTE_FILE" != *..* ]] || exit 2
[[ "$RESTORE_DATABASE" =~ ^[a-zA-Z0-9_]+_restore_test$ ]] || exit 2
# createdb fails if the named database exists; this script never drops a DB.
createdb "$RESTORE_DATABASE"
ssh -o BatchMode=yes "$BACKUP_SSH_TARGET" "sha256sum -c '$BACKUP_REMOTE_FILE.sha256' >&2 && cat '$BACKUP_REMOTE_FILE'" |
  pg_restore --exit-on-error --no-owner --no-privileges --dbname="$RESTORE_DATABASE"
psql -X -v ON_ERROR_STOP=1 --dbname="$RESTORE_DATABASE" -c \
  "SELECT p.season,p.gw,b.id,b.source_payload IS NOT NULL AS replay_available FROM analytics_publications p JOIN analytics_benchmarks b ON b.id=p.benchmark_id ORDER BY p.season,p.gw"
printf 'Restored into %s. Run analytics:replay against this database, then perform the API smoke test.\n' "$RESTORE_DATABASE"
