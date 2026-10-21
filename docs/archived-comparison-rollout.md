# Archived comparison precomputation

This branch preserves the unpublished optimization originally committed as
`044c891`, reconciled with the four production commits through `bb568ff` and
the October 21 incident fixes. It is excluded from the production cleanup
deployment. The abandoned merge in the main checkout can be removed without
losing this implementation.

The design is worth keeping: read at most three comparison-range rows instead
of scanning manager history during each cold request. The rollout is not ready:

- The migration gives existing cumulative coverage counters zero defaults.
  Historical cumulative data must be backfilled before comparison aggregates
  are trustworthy.
- Requests deliberately fail when a selected range has no precomputed rows.
  Migrations alone are insufficient; publish historical ranges before switching
  the API to this version.
- The cumulative backfill and range rebuild can generate substantial writes,
  WAL, and temporary files. Production has roughly 3 GB free on a 38 GB root
  filesystem and scheduled manager ingestion is being withheld by a 4 GiB
  guard. Provision headroom and measure peak usage before a rollout.
- The merged rebuild uses live summary points/ranks for provisional events.
  Validate SQL results against the deployed implementation for finalized and
  provisional ranges, including missing transfer/hit/bench data and both
  Triple Captain halves. Existing unit tests do not establish SQL parity.
- Captain-choice and rank-band captain-rate queries still run on the request
  path. This change alone does not resolve every cold MyTrends timeout.

Build, touched-file lint, and the existing 50-test suite passed during incident
preparation. Resume from the latest production main branch, review the actual
diff, and repeat validation when this work is revived.
