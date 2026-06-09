# `populate-managers` — manager sample ingestion

This is the **recurring cron job** that builds and refreshes the stratified sample of FPL managers used by My Trends. Every 15 minutes it processes another batch of managers, writes their per-GW history and captain picks to the DB, and moves on.

> If you're looking for the one-off scripts that fill historical gaps, see [`backfill-nonactive-history.md`](./backfill-nonactive-history.md) and [`backfill-picks.md`](./backfill-picks.md).

## What it does, in plain terms

1. Wakes up every 15 minutes via system cron.
2. Picks up to **5,000 managers** to process this run, split across three "strata" (rank bands).
3. For each manager, it asks the FPL API: what did you score per GW, and who did you captain?
4. Writes that into `manager_summary`, `manager_history`, and `manager_picks`.
5. Goes back to sleep.

After a few days running, the database holds enough breadth to estimate any user's range rank and compare them against the field.

## The three strata

| Stratum | Whose ranks                                   | How we sample them                                  |
| ------- | --------------------------------------------- | --------------------------------------------------- |
| **A**   | top 10,000 overall                            | full census — pages 1–200 of FPL's "Overall" league |
| **B**   | 10,001 – 100,000                              | every 5th page (1-in-5 sampling) of pages 201–2000  |
| **C**   | 100,001 – `MAX(events.ranked_count)` (~12.6M) | random entry-ID probing in `[1, 15,000,000]`        |

Stratum A is a full census so we know exactly. B is sampled densely enough that scaling × 5 is essentially direct measurement. C is the deep tail — sparse, extrapolated heavily.

## What happens to each manager

For every manager the run touches:

1. **Skip if already processed this GW.** `manager_summary.last_checked_gw === currentGw`? → done.
2. **Fetch history.** Hit `/entry/{id}/history/`. Get every finished GW's points, transfers, hits, bench points.
3. **Classify.** Active / inactive / trolling — recorded on `manager_summary.rejected_reason` (active = NULL).
4. **Write history rows.** One per GW into `manager_history`, regardless of classification. (We need inactives' early scores for the rank count to be accurate.)
5. **Fetch latest GW's picks.** If `manager_picks` is missing the current GW, hit `/entry/{id}/event/{currentGw}/picks/` — record captain, vice-captain, multiplier, active chip. Just the latest GW; historical depth is the picks-backfill's job.
6. **Update `last_checked_gw`** so we skip them on subsequent runs _until a new GW finishes_.

## Budget allocation

Each 5,000-entry run is split across the strata that still have work:

```
stratum A (if not fully covered):  2,500
stratum B (if not fully covered):  1,500
stratum C (always):                remainder (1,000–5,000)
```

Stratum C always gets budget so the deep tail starts filling on day one rather than waiting for A and B to complete first.

## What happens when a new GW finishes

`currentGw` flips (say 33 → 34). The `last_checked_gw === currentGw` skip releases — every sampled manager becomes eligible again. Over the next ~75 minutes (5,000/run × 4 runs/hour) the cron walks the entire ~25k–30k sample, fetching each manager's GW34 picks. Steady-state throughput.

## How to invoke it

### Production (the cron)

Already configured. Crontab line on the production server:

```cron
*/15 * * * * cd /home/deploy/fpl-trends-api && /usr/bin/node dist/database/populateManagers.js >> /home/deploy/populate-managers.log 2>&1
```

Logs go to `/home/deploy/populate-managers.log`.

### Manual run (rare)

If you want to trigger it ad-hoc — for example, after a deploy that bumped `STRATUM_C_ID_MAX` and you want to start sampling the new tail immediately rather than waiting for the next cron tick:

```bash
ssh deploy@91.98.145.120
cd ~/fpl-trends-api && npm run populate-managers
```

Each invocation processes ≤ 5,000 entries then exits. Re-run as many times as you like; cursors persist.

### From a fresh checkout (locally)

```bash
cd fpl-trends-api && npm run populate-managers
```

You need `DATABASE_URL` in `.env` and a populated `events` table (run `npm run populate` first if starting from empty).

## Tail the cron log

```bash
ssh deploy@91.98.145.120
tail -f /home/deploy/populate-managers.log
```

What a healthy run looks like:

```
[populateManagers] Starting: currentGw 33, A page 80/200 (budget 2500), B page 1340/2000 (budget 1500), C random (budget 1000)
[populateManagers] Run finished: {"pagesProcessed":92,"processed":4974,"active":4612,"inactive":318,"trolling":12,"fetchFailed":32,"skipped":0,"outOfStratum":0,"aborted":false,"finalDelayMs":300}
```

A run that hit rate limits and backed off:

```
[populateManagers] Run finished: {"processed":1240,"active":1180,"...","aborted":true,"finalDelayMs":2400}
```

`aborted: true` means the governor stopped it after 3 consecutive errors. The next cron tick will retry where the cursor left off — no manual recovery needed.

## Safety rails

- **Lockfile** at `<os.tmpdir()>/fpl-populate-managers.lock` prevents two runs from overlapping if a tick is slow.
- **Adaptive backoff** in [`rateLimitGovernor.ts`](../src/managers/rateLimitGovernor.ts) — on `429` / `503` it pauses 5 minutes and doubles the inter-batch delay. After 3 consecutive errors the run aborts cleanly.
- **Cursors in `app_metadata`** (`manager_ingest_cursor_a`, `manager_ingest_cursor_b`) so each run resumes where the last one stopped. Wraps to start when fully covered.
- **End-of-season closure** follows the bootstrap-observed season-end signal from the bulk populate job. After `SEASON_END_GRACE_DAYS` (default `5`), `populate-managers` keeps running until `manager_sample_gw_finalized=1` for the final GW, then writes `season_end_manager_ingest_closed_for_season` and future cron ticks skip.

## Inspecting progress

```sql
-- How big is each stratum (active only)?
SELECT stratum, COUNT(*) AS active
FROM manager_summary
WHERE rejected_reason IS NULL
GROUP BY stratum;

-- Where are the cursors?
SELECT * FROM app_metadata WHERE key LIKE 'manager_ingest_cursor%';

-- How many trolls / inactives have we seen?
SELECT rejected_reason, COUNT(*)
FROM manager_summary
GROUP BY rejected_reason;

-- Picks coverage (how many GWs per manager on average)?
SELECT ms.stratum,
       COUNT(DISTINCT ms.entry_id) AS managers,
       COUNT(mp.entry_id) AS picks_rows,
       ROUND(COUNT(mp.entry_id)::float / NULLIF(COUNT(DISTINCT ms.entry_id), 0), 1) AS avg_gws_per_mgr
FROM manager_summary ms
LEFT JOIN manager_picks mp ON mp.entry_id = ms.entry_id
GROUP BY ms.stratum;
```

## When to worry

- **Cron silent for hours** — the lockfile may be stale. SSH in: `ls -la /tmp/fpl-populate-managers.lock`. If it points at a PID that's no longer running, delete it: `rm /tmp/fpl-populate-managers.lock`.
- **`aborted: true` for several runs in a row** — FPL is rate-limiting our IP. Check `pm2 logs fpl-trends-api` for upstream `502`s on `/api/manager/...` requests. The governor will recover automatically; if it doesn't within an hour, drop concurrency in [`populateManagers.ts`](../src/database/populateManagers.ts) (`HISTORY_BATCH_SIZE`).
- **Zero progress for one stratum** — its cursor probably reached the end and wrapped. Check `app_metadata` cursor values vs. the `STRATUM_A_LAST_PAGE` / `STRATUM_B_LAST_PAGE` constants.

## Related files

- [`src/database/populateManagers.ts`](../src/database/populateManagers.ts) — the orchestrator + `processEntry`
- [`src/managers/fetchManager.ts`](../src/managers/fetchManager.ts) — FPL API wrappers
- [`src/managers/fetchPicks.ts`](../src/managers/fetchPicks.ts) — picks fetch + `summarizePicks`
- [`src/managers/activityFilter.ts`](../src/managers/activityFilter.ts) — pure classifier
- [`src/managers/rateLimitGovernor.ts`](../src/managers/rateLimitGovernor.ts) — backoff state machine
