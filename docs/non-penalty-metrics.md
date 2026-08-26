# Non-penalty analytics

FPL Trends keeps the raw FPL `expected_goals` and
`expected_goal_involvements` fields for audit, but all attacking analytics use
their non-penalty equivalents.

## Sources and reconciliation

- FPL supplies fixture histories, xG, xA, xGI, and missed-penalty counts.
- The official Premier League public feed supplies completed fixtures, Opta
  fixture/player IDs, and penalty goal events (`P`).
- Historical deep syncs read individual fixture events for scored (`P`),
  off-target missed (`MP`), and saved (`SP`) penalties. `MP` and `SP` are
  normalized to FPL's single `penalties_missed` definition.
- A finalized current season with 380/380 reconciled fixtures is accepted as
  complete historical coverage at the next season reset, so the new season's
  `history_past` data does not require a manual backfill.
- Premier League fixture Opta IDs (`g123`) join to FPL fixture `code=123`;
  player Opta IDs (`p456`) join to FPL player `code=456`.

No approximate or raw-xG fallback exists. A missing season, fixture, player,
team, event, or completed-fixture mapping makes population/backfill exit
non-zero. The last published relational/archive payload remains the only
servable payload.

## Fixture calculation

Each penalty attempt removes Opta's constant `0.79` xG before aggregation:

```text
attempts = penalties_scored + penalties_missed
npxG = max(0, round2(xG - 0.79 * attempts))
npxGI = max(0, round2(xGI - 0.79 * attempts))
nonPenaltyGoals = max(0, goals_scored - penalties_scored)
```

A clamp logs a reconciliation warning. xA is unchanged. Player xGC remains
the raw FPL value and includes penalties. Team npxGA is the opposing team's
fixture-level npxG, rather than an on-pitch player approximation.

## Operations

Deploy and populate in this order:

```bash
npm run migrate
npm run backfill-non-penalty
npm run check-non-penalty
npm run populate
```

`backfill-non-penalty` is repeatable. It refreshes the current ledger, deep
syncs every archived/history-past season that exposes expected data, enriches
current player histories and history-past rows, rebuilds team history, and
updates each archive only after that season reconciles completely.

`check-non-penalty` is read-only. It checks current feed coverage, exact
history-to-ledger joins, the npx formulas, team npxG/npxGA invariants, and the
required current/archive response shape. `/api/health` exposes the current
feed season, competition-season ID, completed/mapped fixtures, penalty totals,
final-season flag, and last successful refresh.

The feed adapter is intentionally strict because the Premier League endpoint
is public and official but undocumented. Any feed-shape change should be
treated as a failed refresh and investigated before publishing new data.
