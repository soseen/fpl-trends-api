# Published My Trends analytics

Implementation is local and not deployed. The API and SPA must be deployed in
the same release window: the former seven manager routes are replaced by
`GET /api/manager/:id/analysis?start=N&end=M`. There is no compatibility layer.

## Serving and preparation

```mermaid
flowchart LR
  FPL[Official FPL] --> Collector[Bounded manager collector]
  Collector --> Facts[Working facts]
  Facts --> Worker[Analytics worker]
  Worker --> Benchmarks[Immutable GW benchmarks + compressed replay sources]
  Benchmarks --> Worker
  Worker --> Results[Prepared manager/range results]
  Browser --> API[Bounded API reads + queue admission]
  API --> Results
  API --> Jobs[Durable PostgreSQL jobs]
  Jobs --> Worker
```

The API reads publication IDs, one prepared result and a job status. It neither
scans sampled manager history nor calls FPL. A new manager/range returns 202 and
the UI polls for preparation. Cold preparation still depends on FPL latency;
moving that work to a worker does not make upstream calls instantaneous. Ready
results expire after five minutes (30 seconds for partial results), and stay
available during refreshes. A failed refresh stops rapid polling and exposes
an error with a manual retry. Each section records its own successful timestamp.

The separate read pool has four connections, a 1.5-second acquisition limit and
a two-second PostgreSQL statement deadline. Queue admission limits pending work
to roughly 2,000 total jobs and three per manager (concurrent admissions can
slightly exceed these soft limits). Existing IP limits remain in force. One
worker claims jobs with `FOR UPDATE SKIP LOCKED`, renewable leases, token-fenced
publication and bounded retries. Dependency waits do not consume retry attempts.
CPU work yields between range calculations so lease renewal remains responsive.
Manager fetch clients share a Retry-After cooldown after an FPL 429; the worker
continues DB-only benchmark jobs while postponing new manager hydration.

Benchmarks are keyed by season/GW/calculation version. Publishing inserts an
immutable generation and changes its pointer in one transaction. A manager job
pins every required GW generation. The response revision also includes the bulk
refresh version. Bulk writes block new calculation work until they complete;
a failed bulk write leaves the guard active until a successful populate rerun.
If PostgreSQL can still read but rejects refresh writes (for example, disk
exhaustion), the API serves the saved bundle with a refresh error; a cold lookup
returns a typed failure. Older prepared results remain readable. Two benchmark generations per GW are
retained. Manager caches retain the latest 20 ranges after a ten-minute grace
period, and expire abandoned results after seven days. Increment `CALCULATION_VERSION` when changing published mathematics,
then republish all GWs and regenerate manager results.

## Definitions and accuracy

- Stored manager GW points are **net of transfer hits**. All comparison score
  means use that definition. The old rounded official gross GW average is no
  longer mixed with a manager's net total.
- Source sampling weights are `stratum population / observed source managers`:
  top 10k, next 90k, and the remaining ranked population. Top 10k/100k range
  cohorts use rank immediately before the range; ranges starting at GW1 use
  end-of-range rank. A missing previous rank does not imply elite membership.
- Range rank uses a weighted score histogram, including negative scores and
  tied-score midranks. Full-season ranges prefer the official FPL rank. A missing
  populated source stratum makes a sample estimate unavailable. Late entrants
  contribute their played GWs; missing internal history does not become zero.
- EO uses the full XV and actual FPL multipliers, including promoted vice,
  Triple Captain, Bench Boost, autosubs and bench zeroes. Ratios retain floating
  precision; Kish effective sample size is a coverage gate, never a surrogate
  population denominator. Thin band samples use explicit, flagged fallbacks.
- Captain bonus is raw player points times `max(multiplier - 1, 0)`. Intended
  captain choice is a separate statistic. Captain benchmarks and most-captained
  frequencies combine independent per-GW source cohorts; they do not require a
  manager to appear in every historical sample. Other range comparison rows use
  the fixed range cohort described above. A representative TC multiplier is
  `2 + TC share / (ordinary captain share + TC share)`.
- **Raw pts / transfer** is the mean per manager of IN-minus-OUT player points
  from each transfer GW through range end, excluding Wildcard/Free Hit
  transfers, lineup/captain assumptions and hit costs. The user and sample use
  this same formula. Detailed Transfer Impact retains its distinct, labelled
  counterfactual lineup/holding-window model.
- Rank-place effects retain the nonlinear score-to-rank curve. Per-GW values
  are contributions to the selected range's ending-rank counterfactual, not
  independently observed daily rank changes. Finalized squad points are checked
  against the official net range score. Finalized sampled squads are independently
  reconciled before they contribute to EO/captain benchmarks; insufficient valid
  coverage prevents final publication. A mismatch fails the personal section rather
  than publishing a plausible wrong total.

Zod validates FPL payloads and the complete API response. `contracts:generate`
derives both repositories' schemas from exported backend response types;
`contracts:check` detects drift. Missing metrics remain nullable and the UI
displays unavailable/error states. Schema changes fail explicitly. Good sections
from an earlier result survive a partial refresh failure, with earlier timestamps.

The sample is capped at 40k per GW: 10k/10k/20k managers. New collection uses a
seeded, resumable permutation of standings pages, with a frozen population frame
for that GW. This is **page-cluster sampling**, not independent Bernoulli draws.
Historical legacy samples have churn/provenance limitations; capping and weighting
them cannot retrospectively eliminate selection bias. Historical nonresponses,
live population changes and a light rank band remain limits on estimates.

`analytics:calibrate -- <generation UUID>` performs a deterministic 80/20 cluster-held-out
full-season rank audit and reports median/mean/p95 absolute rank error. New
samples retain their source standings page. Legacy rows without that provenance
use inferred rank blocks, reported explicitly as inferredClusters; their reports
need extra caution. It does
not certify arbitrary-range accuracy or provide cluster-aware confidence
intervals. There is no public census answer for arbitrary partial ranges. The UI
therefore labels its bar **sample coverage**, not numerical accuracy. Run and
retain calibration reports on representative production snapshots before rollout.

## Validation and release sequence

1. Review both repository diffs together. Run `npm ci`, backend `build`, `lint`,
   `contracts:check`, `test`, and frontend `typecheck`, `lint`, `build`. Local validation passed all 81 tests with no skips, both builds and type
   checks, backend lint and frontend lint (which retains pre-existing warnings).
   The new CI
   job provisions PostgreSQL 16 and executes the migration/integration tests.
   Locally, integration tests require `ANALYTICS_TEST_DATABASE_URL` naming a
   dedicated database ending in `_test`, with the existing schema migrated.
2. Acquire a restorable database export before destructive cleanup. No external
   storage is currently available, so **off-server backups are not active**.
   Production protection against complete disk/host loss is still pending.
3. Pause manager cron for the initial publication window. Apply the two new
   migrations (`npm run migrate`); neither rewrites or deletes existing facts.
   Build the backend, then run `npm run analytics:benchmarks` to enqueue every
   played GW. Run a single analytics worker, observe memory, disk headroom, query
   temp files and leases, then validate every publication.
4. Replay a generation for every GW with `analytics:replay -- <UUID>`. Run held-out
   audits and compare known manager IDs/ranges against official score history,
   prior trusted results and manual examples. Historical data defects can require
   targeted backfill. Do not interpret the synthetic test as a production pilot.
5. Configure the optional restricted read role from `ops/postgresql-roles.sql`
   and `ANALYTICS_READ_DATABASE_URL`. Apply role limits with an administrator;
   migrations must continue using an owner role. Limit the worker Prisma pool
   using the URL parameters shown in `ops/analytics.env.example`.
6. Start/reload `ops/ecosystem.config.cjs` from the API repository root, deploy
   the SPA built with `API_BASE_URL=/api`, resume cron with the bounded sampler,
   and watch readiness and request/job timings. Both PM2 process names must be
   saved with `pm2 save`. The worker has a separate heap/restart limit; tune only
   after measuring the full SQL-to-publication path on the 4 GiB host.
7. Roll back both application releases together if needed. New tables are
   additive. Before source pruning, original facts and offline legacy builders
   remain available. After pruning, rollback needs replay/FPL hydration or a
   restored export; do not switch back to the old population-scanning endpoints.

`analytics:benchmark` is an isolated CPU/memory smoke test for 40k managers × 38
GWs; it includes all 38 start-range keys. It is not a production SQL load test.
Local integration prepared reads measured 83–168 ms p95 with 20 concurrent
requests; the budget asserted by the test is 2 seconds. These figures do not
predict Hetzner latency. Original population scans took tens of seconds, but the
production before/after comparison remains part of rollout.

## Retention, failures and recovery

Normalized replay input is gzipped in `analytics_benchmarks.source_payload` and
checksum-verified during replay. Finalized historical rebuilds replay this frozen
source instead of using a fragment of a retired roster. Rebuilding historical
source facts requires explicit ANALYTICS_REBUILD_HISTORICAL_FROM_FACTS=true and
a complete restored/backfilled roster; never use that switch after pruning only
a subset of managers. It preserves repeated transfer operations that
the legacy relational PK could merge. Storage scales with the bounded sample,
not millions of refreshed accounts. It is **inside PostgreSQL**, so it is replay
input and not an independent backup.

`analytics:prune` defaults to a dry run. `--apply` removes at most 500 obsolete
working managers, preserving the current finalized sample and recently prepared
users. It refuses to run unless every played GW has a finalized generation with
retained source input. Enable recurring batches with
`ANALYTICS_PRUNE_WORKING_FACTS=true` only after the release audit and a verified
recoverable archive. Initial legacy cleanup can take many batches; monitor WAL
and autovacuum. DELETE does not shrink files immediately. Do not run VACUUM FULL
on the nearly full production disk; arrange headroom for any rewrite separately.
Offline legacy aggregates are retained for parity/recovery and are no longer
rebuilt by cron or read by the new manager API.

Structured logs include request IDs, normalized routes, status, duration, job
kind, retries and section failures. `/api/health/live` checks the process;
`/api/health/ready` checks the DB, publications, heartbeat, queue delay and recent
unexpected job failures. Collector success age is included for monitoring.
Install `ops/pm2-logrotate.conf` with the appropriate production log path. Run
`bash ops/monitor.sh` from an OS monitor and configure an **external uptime monitor**
for host-down alerts; recent partial results also degrade readiness. Neither has been activated by this code change.

Once an SSH-accessible off-server destination exists, configure
`ops/backup-offsite.sh` with libpq credentials, a restricted SSH user and an
existing destination directory. It streams a consistent compressed `pg_dump`
directly to that host, checks the transfer and records completion; no dump is
staged on the production root disk. Schedule daily, retain multiple dated copies
on the destination, and enable `REQUIRE_OFFSITE_BACKUP=true`. Daily dumps imply
up to a day of data loss; use WAL archiving/physical backups if a smaller RPO is
required. PostgreSQL's [SQL dump documentation](https://www.postgresql.org/docs/16/backup-dump.html)
describes the consistency guarantee and the separate need to preserve roles.

`ops/restore-drill.sh` verifies the remote checksum and restores into a **new**
`*_restore_test` database; it never drops an existing database. Run replay,
calibration and API smoke checks against the restored database before calling a
backup verified. Preserve role definitions, configuration and private credentials
separately. [pg_restore](https://www.postgresql.org/docs/16/app-pgrestore.html)
provides `--exit-on-error`; the drill uses it. Backup/restore scripts need Linux
operational testing with the eventual storage host; that cannot be validated
without a destination. PostgreSQL [resource limits](https://www.postgresql.org/docs/16/runtime-config-resource.html)
complement the application timeouts and disk preflight, but do not replace a
backup or prevent every PostgreSQL failure.
