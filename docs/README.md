# Per-flow docs

Single-purpose docs for the more complicated server-side flows. Each one explains the flow in plain terms, gives example invocations, and lists the SQL/CLI commands you'd actually run when operating the system.

For the high-level architecture / project structure / deployment story, see the top-level [`Readme.md`](../Readme.md) instead.

| Doc | Cadence | Purpose |
|---|---|---|
| [`populate-managers.md`](./populate-managers.md) | recurring (cron, every 15 min) | Ingest the stratified sample of FPL managers — history + per-GW picks |
| [`backfill-nonactive-history.md`](./backfill-nonactive-history.md) | one-off (≈30–35 min) | Repair history rows that the pre-fix code path deleted on inactive/troll classification |
| [`backfill-picks.md`](./backfill-picks.md) | one-off (≈6–9 hours) | Fill historical captain picks for every (sampled manager, finished GW) pair |

## Adding a new doc here

Aim for a single flow, in plain terms, with copy-pasteable commands. The existing files are the template — keep the section headings consistent so anyone scanning the docs folder can find the same information in the same place across docs.
