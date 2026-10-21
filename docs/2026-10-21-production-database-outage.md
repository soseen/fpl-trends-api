# My Trends production database outage — 2026-10-21

This is the incident investigation record. The subsequent
[change review](2026-10-21-change-review.md) records the final Git cleanup and
deployment decisions; statements below about uncommitted files and an unfinished
merge describe their state during the investigation.

## Confirmed findings

- PM2 API error logs show Prisma `P1001`: cannot reach `localhost:5432`.
  Failures affect range rank, comparison, team impact, transfers, and captain
  impact. The live-history helper also makes trajectory database-dependent.
- `pg_lsclusters` reports PostgreSQL 16/main down. Its systemd unit failed
  on October 13 at 14:42:42 UTC with exit code 1; `Restart=no`.
- The root filesystem initially reported 100% usage with only 302 MB available.
- A public request for manager 18885, GW2–6 range rank returned HTTP 500 in
  58 ms; summary returned HTTP 200 in 37 ms. These are availability failures,
  not the previously documented comparison-query latency regression.
- Scheduled manager ingestion is also failing because PostgreSQL is down.
  Data freshness must be checked after database recovery.

## Recovery performed

Ran `npm cache clean --force` as deploy, removing disposable package cache.
Available root disk space increased to 1.9 GB (95% used). No database files
were removed or modified. The operator then started PostgreSQL successfully.
PostgreSQL completed automatic WAL recovery and accepted connections.
The operator also vacuumed old system journals; subsequent checks showed
approximately 3.1 GB free (92% used), varying with temporary query files.

## Administrator access and original failure evidence

The deploy account requires a sudo password; root SSH with the available key
is denied. Database logs and storage directories are not readable by deploy.
The following commands describe the original recovery investigation:

```bash
sudo journalctl -u postgresql@16-main --since '2026-10-13 14:30:00 UTC' --until '2026-10-13 15:00:00 UTC' --no-pager
sudo tail -100 /var/log/postgresql/postgresql-16-main.log
sudo du -h --max-depth=2 /var/lib/postgresql /var/log | sort -h | tail -30
sudo systemctl start postgresql@16-main
pg_isready
```

Disk pressure is a likely contributor, but the database failure's exact cause
is unconfirmed until privileged logs are inspected. There is no evidence yet
that the recent precomputed comparison aggregates caused the outage. Check
database relation sizes and WAL usage after recovery before attributing disk
growth to a particular table or optimization. Do not delete PostgreSQL data or
WAL files manually.

The October 13 log has rotated into `postgresql-16-main.log.1`, also protected
by OS permissions. Grepping only the current log does not inspect that failure.
The recovery warning about possible corruption was followed by successful
redo/checkpoint completion; it is not itself evidence of confirmed corruption.

## Additional ingestion failure fixed

After restart, a manual bulk refresh failed at `prisma.events.upsert()`:
`Argument transfers_made must not be null`. FPL's bootstrap payload now returns
null for some historical event transfer totals. The existing Prisma field and
TypeScript bootstrap type incorrectly required a number.

Applied the targeted `20261021120000_nullable_event_transfers` migration and
rebuilt/restarted the production API. `events.transfers_made` now accepts null;
comparison's population transfer average returns null when a GW count or
population denominator is unavailable, rather than treating missing data as
zero. Updated the frontend response type as well (no runtime frontend change).

A full production bulk refresh then succeeded, publishing events and player
history through GW7 with freshness version `2026-10-21T09:55:04.010Z`.
Scheduled manager ingestion resumed, but its sample metadata still reports GW6
and must catch up to the refreshed events.

The fix was validated in a separate worktree based on the exact production
commit `bb568ff`: build, touched-file lint, and all 50 existing tests passed.
Frontend typecheck passed. The original checkout's unfinished merge remains
untouched; whole-checkout compilation is blocked by its existing conflict in
`comparisonCohorts.ts`. Production contains the targeted source/schema hotfix
as uncommitted changes, also mirrored in the original checkout.

## Storage and performance findings

The database occupies approximately 23 GB. Largest relations including indexes:

| Relation              |   Size |
| --------------------- | -----: |
| manager_transfers     | 8.0 GB |
| manager_cumulative    | 5.7 GB |
| manager_pick_elements | 5.3 GB |
| manager_history       | 2.1 GB |

Planner statistics estimated roughly 5.1 million manager summaries and
13.7 million history/cumulative rows. Refreshed statistics with `ANALYZE` on
the hot manager tables and events after recovery.

Cold comparisons still scan/group population-scale history. Early probes
exceeded 55 seconds; captain/team impact took approximately 49–53 seconds.
Client aborts did not cancel the corresponding database queries. Warmed
comparison requests succeeded in about 67 ms. This is a separate performance
issue from the database-down HTTP 500s.

Production runs `bb568ff`, without local commit `044c891`'s precomputed
comparison optimization. Its `comparison_range_stats` table is absent as
expected for that version. An exploratory readiness query against that table
caused a diagnostic-only SQL error, not an application endpoint failure.
Do not deploy the unfinished local merge or run a large cumulative backfill
without validating the merge and planning storage headroom.

Query-plan experiments ran only in temporary diagnostic scripts with 40-second
statement limits. No experimental query hints were applied to application code.

An isolated checkout at `../fpl-trends-api-incident` now contains a resolved
version of the comparison optimization merged with production's captain and
live-summary fixes. Its read-model rebuild preserves the live summary
points/rank semantics. That combined version also passes build, touched-file
lint, and all 50 tests. It has not been deployed or backfilled: the cumulative
backfill rewrites millions of rows and needs planned storage headroom. The
original checkout's unresolved file and merge index were preserved.

## Verification after recovery

Probe summary, trajectory, range-rank, comparison, team-impact, transfers,
and captain-impact for manager 18885, using `start=2&end=6` on range routes.
Repeat with a second range to exercise cold reads. Inspect new API logs for
database and schema errors, then verify scheduled ingestion and read-model
freshness. Successful cached bulk responses alone do not establish recovery.

Final post-deployment probes confirmed summary, trajectory, range rank and
transfers return HTTP 200 on both GW2–6 and GW3–6. Cold comparison, team impact,
and captain impact still exceeded the diagnostic client's 55-second timeout.
The nullable-data hotfix and database restart repair availability/ingestion;
they do not resolve this separate cold-query performance problem.

## Blocking rebuild discovered and mitigated

A later `pg_stat_activity` inspection identified the immediate cause of the
post-restart team/captain stalls: backend 430317 was inserting rebuilt
`rank_band_player_exposure_gw` rows for over five minutes, waiting on temporary
file writes. Its transaction first truncated the table, holding an exclusive
relation lock. Two API backends had waited on that lock for over 300 seconds,
even after their HTTP clients timed out. Available disk fell to 1.4 GB.

Stopped ingestion with the existing `killPopulate` script; it exited cleanly,
the transaction rolled back, the old read model remained available, blocked
reads resumed, and free disk returned to about 3.3 GB.

Changed this rebuild's transactional `TRUNCATE` to `DELETE`. The table is small;
MVCC now lets readers use the last committed snapshot during a rebuild. The
production ingest code was rebuilt with this fix. This specifically addresses
reader blocking; it does not make the rebuild's expensive aggregate cheaper.

Added `src/database/populateManagersWithDiskGuard.ts` and changed the deploy
user's manager-ingest cron to invoke its compiled entrypoint. It skips ingestion
below 4 GiB available on the shared root filesystem. Verified the guard skips
at the current approximately 3.1 GiB free. Original crontab is saved at
`/home/deploy/crontab-before-disk-guard-20261021.txt`. Ingestion is therefore
temporarily withheld until capacity is added or sufficient space is reclaimed;
the manager sample is not yet caught up to GW7.

After releasing the lock, a cold GW4–6 probe returned team impact in 45.1 s
and captain impact in 44.8 s. Other cards returned 200 as well, except comparison,
which still exceeded 60 seconds. The comparison optimization is prepared in
the isolated checkout, but needs safe backfill capacity before rollout.

The subsequent GW2–6 pass returned HTTP 504 for comparison and captain impact
at approximately 60 seconds. Therefore captain queries also still need tuning;
releasing the ingestion lock does not establish reliable cold performance for
all ranges. Final disk check showed 2.7 GB available (93% used). The incident
is partially mitigated, not fully resolved.

## Recurrence prevention

After identifying storage growth, configure bounded journal/application log
retention and disk alerts with enough headroom for database maintenance.
Before cleanup the system journal occupied about 1.9 GB. Measure table, index, WAL,
and temporary-file usage before deciding whether retention, maintenance, or
larger storage is needed. Add database availability monitoring: PM2 remaining
online does not imply PostgreSQL is healthy.
