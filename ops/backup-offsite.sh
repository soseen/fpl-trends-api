#!/usr/bin/env bash
set -euo pipefail
# Configure PG service/.pgpass and a restricted SSH destination. No local dump
# is staged on the small production filesystem. An unset destination fails.
: "${BACKUP_SSH_TARGET:?Off-server storage has not been configured}"
: "${BACKUP_REMOTE_DIR:?Set an absolute directory on the backup host}"
[[ -n "${PGDATABASE:-}" || -n "${PGSERVICE:-}" ]] || { echo 'Set PGDATABASE or PGSERVICE' >&2; exit 2; }
[[ "$BACKUP_SSH_TARGET" =~ ^[a-zA-Z0-9_.@-]+$ ]] || exit 2
[[ "$BACKUP_REMOTE_DIR" =~ ^/[a-zA-Z0-9_./-]+$ ]] || exit 2
[[ "$BACKUP_REMOTE_DIR" != *..* ]] || exit 2
stamp=$(date -u +%Y%m%dT%H%M%SZ)
remote_file="$BACKUP_REMOTE_DIR/fpl-$stamp.dump"
PGOPTIONS="${PGOPTIONS:-} -c statement_timeout=0" pg_dump --format=custom --compress=6 --no-owner --no-privileges --lock-wait-timeout=5s |
  ssh -o BatchMode=yes -o ConnectTimeout=10 "$BACKUP_SSH_TARGET" \
    "umask 077; cat > '$remote_file.partial' && mv '$remote_file.partial' '$remote_file' && sha256sum '$remote_file' > '$remote_file.sha256'"
psql -X -v ON_ERROR_STOP=1 -c "INSERT INTO app_metadata(key,value) VALUES ('analytics_last_offsite_backup',now()::text) ON CONFLICT(key) DO UPDATE SET value=excluded.value" >/dev/null
printf 'Off-site backup completed: %s\n' "$stamp"
