#!/usr/bin/env bash
set -euo pipefail
# Use an external uptime service for host-down alerts as well. This local probe
# exits nonzero for cron/systemd monitoring and never transmits notifications.
curl --fail --silent --show-error --max-time 5 http://127.0.0.1:3000/api/health/ready >/dev/null
available_kib=$(df --output=avail / | tail -1 | tr -d ' ')
(( available_kib >= 4 * 1024 * 1024 )) || { echo 'Database disk headroom below 4 GiB' >&2; exit 1; }
# Enable this check only after off-server storage and backup cron are active.
if [[ "${REQUIRE_OFFSITE_BACKUP:-false}" == true ]]; then
  recent=$(psql -X -At -v ON_ERROR_STOP=1 -c "SELECT COALESCE((SELECT value::timestamptz>now()-interval '26 hours' FROM app_metadata WHERE key='analytics_last_offsite_backup'),false)")
  [[ "$recent" == t ]] || { echo 'Off-site backup is missing or stale' >&2; exit 1; }
fi
