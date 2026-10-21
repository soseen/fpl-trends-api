# October 21 change review

The cleanup keeps the production incident fixes on `main`, removes the abandoned
merge, and preserves the unfinished comparison optimization on a pushed archive
branch. No unfinished optimization migration or large backfill is included in
the production deployment.

| Changes                                                                                                                                      | Decision                         | Reason                                                                                                           |
| -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `7799df9`, `5805393`, `d98ba4c`, `bb568ff`: captain comparisons, live history/rank freshness, ranked-population fallback, and tests          | Keep existing production commits | Already on GitHub and production; they appeared as staged local changes because a merge had not finished.        |
| Nullable event transfer count, matching bootstrap/API types, and comparison null handling                                                    | Commit, push, deploy             | Restores ingestion when FPL omits historical transfer totals and avoids inventing zero averages.                 |
| Transactional `DELETE` for the exposure read-model rebuild                                                                                   | Commit, push, deploy             | Readers retain the last committed snapshot instead of waiting behind `TRUNCATE` for the whole rebuild.           |
| Manager-ingest disk guard and cron entrypoint                                                                                                | Commit, push, deploy             | Withholds scheduled ingestion below 4 GiB free; it is already configured in production.                          |
| Incident evidence and performance-design notes                                                                                               | Keep documentation               | Records recovery, current limitations, and the distinction between proposed and deployed code.                   |
| Unpublished `044c891` comparison precomputation, migration, cumulative counters, backfills, diagnostics, and merged live-summary adjustments | Remove from main; archive        | Needs historical backfill, SQL parity checks, and capacity planning before requests can depend on the new table. |
| Frontend nullable response type                                                                                                              | Commit, push, deploy             | Matches the deployed backend contract.                                                                           |
| Frontend case-study claims that comparison precomputation has shipped                                                                        | Correct and deploy               | Comparison/captain cold queries remain expensive; the optimization is not in production.                         |
| Incident checkout line-ending-only changes                                                                                                   | Discard                          | No functional change; old migrations and unrelated source files should not be rewritten.                         |

## Archived work

Branch: `archive/my-trends-precompute-20261021`, commit `0836ec8`.
It contains the resolved implementation, the production fixes available during
the review, and `docs/archived-comparison-rollout.md` with rollout requirements.
Build and all 50 existing tests passed. This is preservation of development work,
not approval to deploy the migration or run its backfill.

The original merge metadata, changed files, production patch, and Git history
were backed up outside the repositories before main was reset to `origin/main`.
The incident checkout remains a clean checkout of the archive branch so its code
is available for future review; it is not a deployment source.

## Production state

The production hotfix files were originally applied without commits. This cleanup
brings those tracked files under the main-branch commit and synchronizes the
server checkout with GitHub. The applied nullable-transfer migration remains in
place. No precomputation migration is run by this deployment.

Scheduled manager ingestion still skips below 4 GiB free. That prevents a repeat
of the observed low-disk rebuild but delays manager-sample freshness. Cold
comparison and captain timeouts remain separate performance work. More disk
headroom and a measured rollout are required before reviving the archive branch.
