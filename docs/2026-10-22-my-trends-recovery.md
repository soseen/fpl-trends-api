# My Trends missing ranks and captain comparisons - October 22, 2026

## Cause

The October 21 availability repair left manager ingestion deliberately paused
below 4 GiB free on the shared root filesystem. Every subsequent manager cron
tick skipped for insufficient disk space. At investigation time, production had
about 3.8 GiB available.

Bulk events had advanced to finished, data-checked GW7, but manager metadata
still held `manager_sample_gw=6`, `manager_sample_gw_cleaned=6`, and
`manager_sample_gw_finalized=0`.

For manager 13231, GW3-7, the public range-rank endpoint returned
`range_rank=null`, `sample_status=stale`, and `sample_size=0`. The frontend's
"Updating" message reflected the stale sample; it did not establish that a job
was running. Captain read models contained GW1-6 only. Both the captain bonus
and most-captained comparisons require coverage throughout the requested range,
so ranges including GW7 returned null comparisons.

## Space recovery

Rebuilt three bloated indexes with `REINDEX INDEX CONCURRENTLY`, preserving
records and keeping the existing indexes available during replacement:

| Index                                        |  Before |  After |
| -------------------------------------------- | ------: | -----: |
| `manager_cumulative_gw_stratum_entry_id_idx` | 1299 MB | 416 MB |
| `manager_cumulative_covering`                | 1697 MB | 415 MB |
| `manager_cumulative_pkey`                    | 1065 MB | 296 MB |

Root filesystem availability increased to 6.5 GiB. All replacement indexes
were valid. The existing disk guard and cron schedule were retained.

The statistics for `manager_transfers` and `manager_pick_elements` were
misleadingly small and had no recorded analyze timestamp. An exact count found
63,627,330 transfer records. An initial `VACUUM FULL` was cancelled before
completion after that count disproved the assumption that this was an almost
empty table. No records were deleted. Future maintenance must account for live
data and temporary rewrite space instead of trusting these stale estimates.

Refreshed planner statistics with `ANALYZE` on `manager_transfers`,
`manager_pick_elements`, `manager_picks`, and `manager_range_score_buckets`.

## Ingestion recovery

Started the existing compiled disk-guarded manager ingestion entrypoint under
the same 1800-second timeout used by cron. Output remains in
`/home/deploy/populate-managers.log`; the existing PID lock prevents overlap.

The run refreshed the overall rank curve, performed the normal GW7 sample
transition, and began fetching manager histories and picks. Metadata advanced
to `manager_sample_gw=7`, `manager_sample_gw_cleaned=7`, and
`manager_sample_gw_finalized=2` (a finished-GW pass in progress).

Once same-GW captain coverage exceeded the existing thresholds in all three
strata, published an interim captain aggregate and GW7 range-score buckets
with the existing `rebuildStratumCaptainPicks()` and
`rebuildManagerRangeScoreBuckets({ endGwOnly: 7 })` functions. The main ingest
continued; no sampling thresholds or finalization flags were weakened.

The 10:15 UTC cron tick passed the disk guard and exited through the existing
"Another run holds the lock" path while the manual catch-up was running.
This confirmed the scheduled entrypoint was active and no longer skipping for
low disk space.

## Verification

Public API probes after interim publication at 10:11 UTC confirmed:

- Manager 13231, GW3-7: estimated rank 2,369,850, instead of null.
- The same manager, GW2-7 and GW7 alone: non-null estimated ranks.
- GW1-7: the official rank remained available alongside the estimate.
- GW3-6: the existing historical range rank remained available.
- GW3-7 comparison for managers 13231 and 18885: captain bonus averages
  36.28 / 51.41 / 51.90 for Average / Top 100k / Top 10k, respectively;
  most captained was Haaland in all three groups.
- `captain_average_partial=false` for both comparisons. The cold GW3-7
  comparison took 13.6 seconds; the second manager took 168 ms using the shared
  range cache.
- GW2-7 comparison also returned captain bonus and most-captained values in
  all three groups. The historical GW3-6 comparison returned those values on
  a subsequent cached request.

These are recovery snapshots, not fixed expected estimates. The sample grows
as ingestion continues, so `sample_status=refreshing` is legitimate while ranks
are already visible. Do not mark the sample finalized manually.

A cold historical GW3-6 comparison exceeded nginx's request timeout. Its
underlying query subsequently completed. This is the separately documented
historical comparison performance issue; restoring GW7 ingestion does not fix
population-scale cold queries for older end gameweeks.

## Focused ingestion fix

Watching the first catch-up exposed another immediate recovery problem: routine
ingestion rebuilt exposure for every historical GW, materializing tens of
millions of pick rows. That step completed in 283 seconds and consumed roughly
3 GiB of temporary space. Stopped the remaining ingest with `killPopulate`
while validating a bounded replacement; collected rows and committed read
models were retained, and temporary disk space was released.

Routine ingestion now supplies `exposureGw=currentGw` to
`rebuildManagerReadModels`. The exposure rebuild deletes and calculates only
that GW, including both the causal branch and GW1's special calculation.
Explicit historical backfills retain the full-rebuild default. This changes
the work done per cron tick without changing exposure formulas or sampling.

Validation before deployment:

- All 50 existing tests passed, along with TypeScript, build, and whole-API lint.
- A new opt-in PostgreSQL integration test passed using an isolated fixture
  schema, which was removed afterward. It checks parity with full rebuilds for
  GW1 and a later GW, changed multipliers, preservation of other GWs and their
  timestamps, and removal of the selected snapshot when sample coverage is lost.
- On actual production data, a scoped GW7 rebuild matched all full-rebuild
  values and left 23,283 historical rows and their timestamps intact. It took
  6.3 seconds on the first run, versus 283 seconds for the full rebuild.

Deployed the changed ingestion source and compiled module. The API process,
frontend, schema, disk guard, and permanent cron configuration were unchanged.
Rebuilt captain, current-GW exposure, running stats, and latest range buckets
using the deployed module. The one-off recovery rebuild skipped unrelated
transfer averages; ordinary cron retains its existing transfer-average refresh.

The deployed recovery rebuild completed at 10:30 UTC in 26 seconds: captain
aggregate 1 second, GW7 exposure 1 second on the warm repeat, running stats
9 seconds, and range buckets 15 seconds. Final free space was approximately
6.3 GiB. Removed the temporary deployment lock and staging directory; normal
guarded cron is enabled and the integration fixture schema is absent.

Final public assertions passed for manager 13231's GW3-7, GW2-7, GW7-only,
and GW1-7 ranks, plus GW3-7/GW2-7 captain comparisons and a second manager
(18885). The latest GW3-7 estimate was 2,504,234 with 6,450 stratum-3 samples;
the sample remains `refreshing` until the normal standings walks finish.
All captain comparison columns were populated. Cold latest-range comparisons
took approximately 12-15 seconds, with a shared-cache request taking 126 ms.

The initial emergency deployment used uncommitted source and test files.
Deployed source and compiled JavaScript hashes matched the locally validated
build. The hotfix, integration test, and this recovery record are included in
the follow-up Git release for deployment through the normal build, migration,
and API restart workflow. A source/compiled before-image is stored outside the
production repository at
`/home/deploy/fpl-ingest-hotfix-before-20261022`.

The subsequent scheduled ingestion pass completed with 10,000 ingested managers,
no fetch failures, and no governor abort. Its scoped exposure rebuild took
8 seconds. The existing transfer-average refresh remained expensive at
957 seconds; that separate performance work is unchanged by this fix.

The archived comparison optimization and broader architecture work remain
outside this recovery.
