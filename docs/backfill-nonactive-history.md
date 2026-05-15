# `backfill-nonactive-history` — re-fetch deleted history rows

A **one-off** script that re-fetches per-GW history for managers whose `manager_history` rows were deleted under the pre-`023c25e` code path (when an inactive/troll classification used to wipe history).

> Once you've run this successfully on a server, you don't need to run it again. Future inactive/troll classifications keep their history automatically.

## Why this exists

Before commit `023c25e`, `populateManagers.processEntry` did this on classification:

```ts
if (klass !== "active") {
  await prisma.manager_summary.upsert({
    /* with rejected_reason */
  });
  await prisma.manager_history.deleteMany({ where: { entry_id: entryId } });
  return klass;
}
```

That `deleteMany` blinded the range-rank count to managers who played early then quit — even though their early-GW scores were real and often _did_ beat the user. The fix keeps the `rejected_reason` flag (so comparison-average queries still skip trolls) but stops deleting history.

The fix only affects **future** ingest runs. To repair the existing data we re-fetch history for the affected managers.

## What it does, in plain terms

1. Finds every manager in `manager_summary` with `rejected_reason IN ('inactive', 'trolling')` who has zero `manager_history` rows.
2. For each, calls `/entry/{id}/history/` and writes one `manager_history` row per finished GW.
3. Logs progress every 200 managers.
4. Exits.

It's idempotent — selects only entries with zero rows, so re-running after partial completion picks up where it left off.

## How to invoke it

### Foreground (you watch it run)

```bash
ssh deploy@91.98.145.120
cd ~/fpl-trends-api
npm run backfill-nonactive-history
```

Expected runtime: **~30–35 minutes** for ~33,000 managers (8 concurrent fetches with a 300ms inter-batch delay → ~16 mgrs/sec sustained). Output looks like:

```
[backfillNonActiveHistory] 32927 managers need history backfill.
[backfillNonActiveHistory] progress: 200 done, 0 failed, 32727 remaining
[backfillNonActiveHistory] progress: 400 done, 0 failed, 32527 remaining
...
[backfillNonActiveHistory] complete: 32910 succeeded, 17 failed.
```

A few hundred failures are normal — FPL IDs that 404 (deleted accounts) or transient timeouts.

### Background (close terminal safely)

If you don't want to babysit the SSH session:

```bash
ssh deploy@91.98.145.120
cd ~/fpl-trends-api
nohup npm run backfill-nonactive-history > backfill-nonactive.log 2>&1 &
disown
```

Then check progress whenever:

```bash
tail -f ~/fpl-trends-api/backfill-nonactive.log
# Ctrl+C exits the tail; the script keeps running.
```

### Already running in foreground and you want to disconnect

If the script is in the foreground of an SSH session you want to close:

1. **`Ctrl+Q`** (in case you accidentally hit Ctrl+S earlier — that freezes terminal output).
2. **`Ctrl+Z`** — suspends the process.
3. **`bg`** — resumes it in the background.
4. **`disown -h %1`** — removes the SIGHUP handler so closing the terminal won't kill it.
5. Close the terminal.

You lose live log output (it was streaming to your now-closed terminal), but the work continues. Verify via SQL — see [Inspecting progress](#inspecting-progress).

## Inspecting progress

The "remaining" count from the live logs corresponds exactly to this query:

```sql
SELECT COUNT(*)
FROM manager_summary ms
WHERE ms.rejected_reason IN ('inactive', 'trolling')
  AND NOT EXISTS (
    SELECT 1 FROM manager_history mh WHERE mh.entry_id = ms.entry_id
  );
```

Run it from a separate session to confirm the script is making progress. The number should drop steadily.

## When to run it

- **Once after deploying commit `023c25e`** (or any commit that includes the rank-undercount fix) on a server that already has manager data.
- **Never again afterwards** — future classifications keep history automatically.
- **Possibly once more after `npm run reset-season`** — wait, no: `reset-season` truncates `manager_summary` and `manager_history` together, so there's nothing to backfill. Skip it.

## When NOT to run it

- Fresh server bootstrap with no manager data yet — pointless, there are no candidates. The first cron run will populate everyone correctly under the new code path.
- During a heavy cron tick — they'd compete for FPL API budget. Not catastrophic (the governor handles it) but slower than necessary.

## Verification (optional)

After completion, sanity-check that range ranks improved against your own FPL ID:

```bash
# Before fix vs. after fix vs. official FPL — example targets:
curl -s 'https://fpltrends.live/api/manager/<your_id>/range-rank?start=1&end=7'  | jq .range_rank
curl -s 'https://fpltrends.live/api/manager/<your_id>/range-rank?start=1&end=15' | jq .range_rank
```

Compare to the cumulative ranks the FPL official app shows on your history page. Within ±5–10% across short and long ranges = healthy.

## Safety rails

- **Idempotent selection** — re-running picks up only entries still missing history.
- **Adaptive backoff** — same `RateLimitGovernor` as `populate-managers`. On `429`/`503` it pauses 5 minutes; on 3 consecutive errors it aborts cleanly. Re-run to resume.
- **No lockfile** — by design. If you start a second run while the first is going, both will scan the same query and split the work; harmless because each individual `(entry_id, gw)` upsert is a primary-key match.

## Related files

- [`src/database/backfillNonActiveHistory.ts`](../src/database/backfillNonActiveHistory.ts) — the script itself
- [`src/managers/fetchManager.ts`](../src/managers/fetchManager.ts) — `fetchEntryHistory` wrapper
- [`src/managers/activityFilter.ts`](../src/managers/activityFilter.ts) — `netPointsForEvent` (same calc as live populate)
