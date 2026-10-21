# My Trends comparison performance incident

Status as of October 21, 2026: the precomputation implementation described here
is archived on `archive/my-trends-precompute-20261021`; it is not deployed to
production. Local timings below describe development validation. The October
production outage was investigated separately. Do not use the rollout commands
until storage headroom, historical coverage, and SQL result parity are verified.

This note records the October 2026 comparison-endpoint regression and its
fix. It is intentionally more detailed than a changelog entry so it can serve
as source material for a future case study covering the complete My Trends
sampling and analytics pipeline.

## Incident summary

`GET /api/manager/:id/comparison?start=1&end=5` took approximately 12.6 seconds
in the browser. Cold production probes for nearby ranges took 18.9-30.9
seconds, while the response body was only about 1.9 KB. Time to first byte was
effectively identical to total request time, locating the delay on the server.

The React comparison table was not involved. It receives a completed response
and synchronously maps it to display rows.

## Evidence and isolation

| Probe                                       |      Result |
| ------------------------------------------- | ----------: |
| Cold production GW2-5                       |     19.13 s |
| Cold production GW1-4                       |     30.87 s |
| Cold production GW3-5                       |     18.88 s |
| Same warmed range, different manager        | 0.26-0.30 s |
| Local live cohort aggregate (~55k managers) |      546 ms |
| Local captain-choice aggregate              |       18 ms |
| Local precomputed reads                     |   25-159 ms |

The same-range/different-manager result was important: `getComparisonCohorts`
caches by range, not manager. Once that range was cached, all per-manager work
completed quickly. The shared range aggregate was therefore the bottleneck.

## Root cause

Commit `f302886` fixed look-ahead bias by classifying comparison managers from
their rank immediately before the selected range. For ranges beginning at
GW1, where no earlier rank exists, it uses rank at the end of the range.

That semantic correction replaced constant-time read-model lookups with a
request-time SQL query that:

1. selected the causal cohort for every sampled manager;
2. scanned every `manager_history` row in the requested range;
3. grouped those rows by manager;
4. aggregated points, transfers, hits, bench points, captain bonus and chips
   by cohort stratum.

The production sample is large enough that this work took 12-30 seconds on a
cold range. A five-minute in-process cache hid the problem after the first
request, but every new slider range, cache expiry, deploy or process restart
could make a user pay the full cost.

Adding another index was insufficient: the query already had useful GW and
rank indexes, but still needed to visit and aggregate a large fraction of the
sample. Longer caching would reduce frequency without fixing cold latency.

## Fix

The causal semantics are preserved, but the population-wide aggregation now
runs after manager ingestion instead of during the HTTP request.

`comparison_range_stats` stores one row for each
`(stratum, start_gw, end_gw)` combination. It contains raw sums and coverage
denominators rather than presentation-ready averages. Keeping them separate
allows the request path to:

- population-weight the three stratified samples;
- combine strata for Average and Top 100k;
- retain Top 10k as stratum 1;
- preserve the 50% completeness gates for partially backfilled data.

The rebuild reads two `manager_cumulative` snapshots per manager and derives a
range by subtraction. Three new cumulative non-null counters distinguish a
real zero from missing transfer/hit/bench data. Two cumulative Triple Captain
flags complete the chip data needed by the table.

The live captain-choice query remains on the request path. It reads the much
smaller `manager_picks` range and took about 18 ms locally, so precomputing it
would add storage and rebuild complexity without addressing the incident.

## Request path after the fix

1. Fetch the requested manager's FPL history, picks and transfer impact.
2. Read at most three indexed rows from `comparison_range_stats`.
3. Run the small captain-choice aggregate over `manager_picks`.
4. Read true FPL stratum sizes and population-weight the sampled rows.
5. Cache the completed range cohort and manager response for five minutes.

The expensive work is independent of manager ID and is now paid once during
the scheduled read-model rebuild.

## Read-model lifecycle

- `populate-managers` refreshes every range ending at the current sampled GW
  after successful ingestion.
- Historical range rows remain available and stable.
- `npm run backfill-comparison-ranges` performs a full historical rebuild.
- `npm run check-local-state` reports cumulative-counter and comparison-table
  readiness.
- Season reset truncates the read model with the other manager analytics
  tables.

## One-time rollout

For the first rollout, migrate and prime the latest range **before restarting
the API on the new code**. The normal `deploy` script restarts immediately
after migration, so use the equivalent manual sequence for this release:

```bash
npm run migrate
# Only if check-local-state reports missing historical ranks:
npm run backfill-manager-ranks
npm run backfill-cumulative
npm run backfill-comparison-ranges
npm run check-local-state
# Then restart the API process on the new build.
```

The order matters. Causal cohorts require `manager_history.overall_rank`, and
existing `manager_cumulative` rows receive zero defaults for the new counters.
Both prerequisites must be ready before range aggregates are created. New and
refreshed managers maintain ranks and counters automatically.

Full rebuilds refresh the latest end-GW first and replace one end-GW slice at a
time, so an existing healthy read model is never globally truncated. For an
urgent repair where only current-GW ranges are missing, use
`npm run backfill-comparison-ranges -- --latest`.

## Validation and performance guardrails

- Compare several old/live-query results captured before rollout against the
  read-model response, including GW1, a later range and a range crossing GW20.
- Verify all three strata exist for populated ranges where the sample covers
  those rank bands.
- Verify missing-data gates still return `null` below 50% coverage.
- Verify both Triple Captain halves match `manager_history.active_chip`.
- Measure a cold, uncached comparison request. Target: under one second for
  cohort work and comfortably below the client timeout end-to-end.
- Measure a second manager on the same range to ensure caching is additive,
  not required for acceptable latency.

## Case-study threads to retain

For the broader My Trends case study, connect this incident to:

- why the sample is stratified and how true-population weights are recovered;
- causal versus outcome-selected cohorts;
- raw ingestion tables versus cumulative and range read models;
- completeness/coverage gates during incremental backfills;
- which calculations remain per-user and which can be shared by range;
- how cron cost, storage and request latency are traded against one another;
- why caches should improve an already-fast query rather than conceal a slow
  one.
