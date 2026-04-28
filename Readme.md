# fpl-trends-api

Backend for **FPL Trends** (https://fpltrends.live) — a Fantasy Premier League analytics platform.

Fetches data from the official FPL API, stores it in PostgreSQL via Prisma, and exposes it through a small REST API consumed by [`fpl-trends-app`](https://github.com/soseen/fpl-trends-app).

> **Operator-focused per-flow docs** for the more complicated jobs live under [`docs/`](./docs/) — see [`populate-managers.md`](./docs/populate-managers.md), [`backfill-nonactive-history.md`](./docs/backfill-nonactive-history.md), and [`backfill-picks.md`](./docs/backfill-picks.md). Read those first if you're trying to operate the system rather than understand the architecture.

---

## Table of contents

1. [Overview](#overview)
2. [Stack](#stack)
3. [Project structure](#project-structure)
4. [Database schema](#database-schema)
5. [API endpoints](#api-endpoints)
6. [Local development](#local-development)
7. [Production deployment](#production-deployment-hetzner)
8. [Operating the production server](#operating-the-production-server)
9. [Data refresh / populate](#data-refresh--populate)
10. [Manager rank estimation (My Trends)](#manager-rank-estimation-my-trends)
11. [Manager comparison (sample averages + top 10k)](#manager-comparison-sample-averages--top-10k)
12. [Backfill scripts (one-off)](#backfill-scripts-one-off)
13. [Start-of-season runbook](#start-of-season-runbook)
14. [Troubleshooting](#troubleshooting)
15. [Known issues](#known-issues)

---

## Overview

The API has three responsibilities:

1. **Ingest** data from the official FPL API (`https://fantasy.premierleague.com/api/...`) — players, teams, fixtures, gameweek events, per-match history.
2. **Store** it in PostgreSQL using Prisma migrations as the source of truth for schema.
3. **Serve** a small set of REST endpoints to the SPA frontend.

Ingest is **manual** — there's no scheduler in the Node process itself. In production we rely on a system **cron** to call the populate script on a schedule (see [Data refresh](#data-refresh--populate)).

The system is **season-aware**: every populate run detects whether the FPL season has changed (by reading the first event's deadline year and comparing it against `app_metadata.current_season` in the DB). On change, all game data tables are wiped and re-populated from scratch.

In addition to the per-player ingest, the API maintains a **stratified sample of FPL managers** in `manager_summary` and `manager_history` tables. This powers the [My Trends](#manager-rank-estimation-my-trends) feature on the frontend, which estimates a user's rank within a chosen gameweek range. Sample collection is incremental and runs via a separate cron-friendly script (`npm run populate-managers`).

---

## Stack

- **Runtime:** Node.js 22+ (LTS)
- **Language:** TypeScript 5.7 (`target: ES2022`, `module: Node16`, strict mode)
- **HTTP:** Express 4.21 + Helmet + Compression + CORS
- **DB:** PostgreSQL 16 via Prisma 6.2
- **Outbound HTTP:** Axios
- **Process manager (prod):** pm2
- **Reverse proxy / TLS (prod):** nginx + Let's Encrypt (certbot)

---

## Project structure

```
src/
├── server.ts                          — Express app, routes, middleware, CORS config
├── fetch.ts                           — HTTP helpers for FPL API calls
├── file.helpers.ts                    — File path constants for cached JSON data
├── types.ts                           — Shared TypeScript types
├── utils.ts                           — General utilities (delay)
├── bootstrapStatic/
│   ├── fetchBootstrapStatic.ts        — Fetches bulk FPL data (teams, events, players list)
│   └── types.ts                       — Bootstrap response types
├── database/
│   ├── client.ts                      — Prisma client singleton
│   ├── populateDatabase.ts            — Orchestrates full data refresh (season-aware)
│   ├── populateManagers.ts            — Stratified sample ingest: history + picks per manager
│   ├── backfillNonActiveHistory.ts    — One-off: re-fetch history for inactive/troll managers
│   ├── backfillPicks.ts               — One-off: fill manager_picks for every (manager, finished GW)
│   ├── seasonManager.ts               — Season detection, wipe, and reset logic
│   ├── resetSeason.ts                 — Manual season reset script
│   ├── insertFootballers.ts           — Upserts player data
│   ├── insertFootballersFixtures.ts   — Upserts upcoming fixtures per player
│   ├── insertFootballersHistory.ts    — Upserts match-by-match history per player
│   ├── insertTeams.ts                 — Upserts team data
│   └── insertTeamHistory.ts           — Aggregates + inserts team-level stats per GW
├── events/
│   ├── getEvents.ts                   — API handler for /api/eventsData
│   └── insertEvents.ts                — Upserts gameweek event data
├── footballers/
│   ├── fetchFootballers.ts            — Batch-fetches per-player summaries
│   ├── getAllFootballersData.ts       — API handler for /api/footballersData
│   ├── types.ts                       — Footballer-specific types
│   └── utils.ts                       — Footballer utilities
├── managers/
│   ├── fetchManager.ts                — FPL API calls for entry/history/standings
│   ├── fetchPicks.ts                  — FPL API call for entry/{id}/event/{gw}/picks/ + summarize helper
│   ├── activityFilter.ts              — Inactive / trolling classifier (pure)
│   ├── rateLimitGovernor.ts           — Adaptive backoff for ingestion
│   ├── getManagerSummary.ts           — Handler for /api/manager/:id/summary
│   ├── getRangeRank.ts                — Handler for /api/manager/:id/range-rank
│   ├── getManagerTrajectory.ts        — Handler for /api/manager/:id/trajectory
│   ├── getManagerComparison.ts        — Handler for /api/manager/:id/comparison (incl. top-10k column)
│   └── types.ts                       — Manager-specific types
├── teams/
│   └── getTeamsData.ts                — API handler for /api/teamsData
└── data/                              — Cached API responses (gitignored)
    ├── raw_bootstrap_static.json
    └── raw_footballers.json

prisma/
├── schema.prisma                      — DB schema (7 models incl. app_metadata)
└── migrations/                        — Prisma migration history
```

---

## Database schema

10 tables, all defined in `prisma/schema.prisma`.

| Table | Purpose | Key fields |
|---|---|---|
| `app_metadata` | Application state KV store | `key`, `value` (stores `current_season`, manager ingest cursors) |
| `footballers` | Player data (~100+ columns) | `id`, `web_name`, `team_id`, `now_cost`, `total_points`, `xG`, `xA`, `xGI`, `ICT`, `form`, `status`, per-90 variants |
| `history` | Per-match player stats | composite PK `(footballer_id, fixture_id)`, `total_points`, goals, assists, xG, xGI, xGC, minutes, opponent |
| `footballer_fixtures` | Upcoming fixtures per player | `footballer_id`, `fixture_id`, `difficulty`, `is_home`, `team_h`, `team_a` |
| `teams` | Club data + strength ratings | `id`, `name`, `short_name`, `strength_*` (attack/defence × home/away) |
| `team_history` | Aggregated team stats per GW | composite PK `(team_id, round)`, `teamXGS`, `teamXGC`, `goals`, `goals_conceded` |
| `events` | Gameweek metadata | `id`, `name`, `finished`, `is_current`, `deadline_time`, `most_selected`, `top_element`, `ranked_count`, `chip_plays` |
| `manager_summary` | One row per FPL manager evaluated for the rank-estimation sample | `entry_id`, `overall_rank`, `total_points`, `stratum` (1/2/3), `rejected_reason`, `last_checked_gw` |
| `manager_history` | Per-GW net points + transfer/bench data for sampled managers (all classifications) | composite PK `(entry_id, gw)`, `points`, `event_transfers`, `event_transfers_cost`, `points_on_bench` |
| `manager_picks` | Per-GW captain choice + active chip per sampled manager | composite PK `(entry_id, gw)`, `captain_element`, `vice_captain_element`, `captain_multiplier`, `active_chip` |

Cascade delete is set on the `footballers → history`, `footballers → footballer_fixtures`, `teams → team_history`, `manager_summary → manager_history`, and `manager_summary → manager_picks` relations. The three manager tables are wiped on season change (they're season-scoped — points and picks only make sense within the season they were earned).

> **Note on `manager_history` for non-active managers:** prior to commit `023c25e` we deleted history rows on inactive/troll classification. This biased range-rank counts (managers who played early then quit looked invisible). The classifier still tags them via `rejected_reason`, but their per-GW history is now retained so the rank-count predicate sees real scores. Comparison-average queries continue to filter `rejected_reason IS NULL` so a 60-hit account doesn't skew "average hits taken".

---

## API endpoints

All endpoints are public (no auth). CORS allowlist is configured via `ALLOWED_ORIGINS` env var.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/footballersData` | All players with team, history, and fixtures (Prisma `include`) |
| `GET` | `/api/teamsData` | All teams with `team_history` |
| `GET` | `/api/totalPlayersCount` | `{ totalPlayers: number }` |
| `GET` | `/api/eventsData` | Gameweek events |
| `GET` | `/api/populate` | Triggers a full data refresh from the FPL API |
| `GET` | `/api/manager/:id/summary` | Manager identity + season totals (proxies `/api/entry/{id}/`) |
| `GET` | `/api/manager/:id/range-rank?start=X&end=Y` | Estimated rank within GW range (see [Manager rank estimation](#manager-rank-estimation-my-trends)) |
| `GET` | `/api/manager/:id/trajectory?start=X&end=Y` | Per-GW cumulative rank trajectory for the chart on `/my-trends` |
| `GET` | `/api/manager/:id/comparison?start=X&end=Y` | Stats vs sample average + top-10k (see [Manager comparison](#manager-comparison-sample-averages--top-10k)) |

The manager endpoints validate `:id` (positive integer ≤ 20M) and `start`/`end` (1 ≤ start ≤ end ≤ 38). They return `400` on invalid input, `404` if FPL doesn't recognise the entry, `502` on upstream FPL failures.

CORS allowed origins are configured via the `ALLOWED_ORIGINS` env var (comma-separated). If unset, it falls back to:

```
https://fpltrends.live
https://www.fpltrends.live
```

In dev (`NODE_ENV !== "production"`), `http://localhost:5000` is also allowed automatically.

---

## Local development

### Prerequisites

- Node 22+
- PostgreSQL 16 running locally (default port 5432)
- A local DB user + database to point Prisma at

### One-time setup

```bash
# 1. Clone
git clone git@github.com:soseen/fpl-trends-api.git
cd fpl-trends-api

# 2. Install deps
npm install

# 3. Create local Postgres role + db (run once)
sudo -u postgres psql <<EOF
CREATE USER fpl WITH PASSWORD 'localdevpass';
CREATE DATABASE "fpl-trends-db" OWNER fpl;
GRANT ALL PRIVILEGES ON DATABASE "fpl-trends-db" TO fpl;
EOF

# 4. .env
cat > .env <<EOF
DATABASE_URL="postgresql://fpl:localdevpass@localhost:5432/fpl-trends-db"
NODE_ENV=development
PORT=3000
# Optional: comma-separated list. Dev auto-allows localhost:5000.
# ALLOWED_ORIGINS="https://fpltrends.live,https://www.fpltrends.live"
EOF

# 5. Apply schema + initial data load (~3 min)
npm run bootstrap
```

### Running

```bash
npm run dev          # tsx with hot reload, port 3000
```

### Other useful commands

```bash
npm run lint         # ESLint check
npm run lint:fix     # ESLint autofix
npx prisma studio    # GUI to inspect the DB
```

### Adding / changing schema

1. Edit `prisma/schema.prisma`
2. `npx prisma migrate dev --name <descriptive-name>` — creates a new migration and applies it locally
3. Commit the new migration folder under `prisma/migrations/`
4. On the server, `npx prisma migrate deploy` will apply pending migrations

---

## Production deployment (Hetzner)

The site runs on a **Hetzner Cloud CX23** (2 vCPU, 4 GB RAM, 40 GB SSD) in Falkenstein, Ubuntu 24.04 LTS, no managed backups (rebuild-on-failure stance — see [`memory/feedback_disposable_infra.md`](../memory/feedback_disposable_infra.md)).

Server IP: `91.98.145.120` · IPv6: `2a01:4f8:c013:a22c::1`

### One-time server bootstrap

This is the full sequence used to bring up the box from a clean Ubuntu 24.04 install. Steps run as `root` are noted; everything else runs as the `deploy` user.

#### 1. SSH hardening (as root)

```bash
apt update && apt upgrade -y
adduser deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh
cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
chown -R deploy:deploy /home/deploy/.ssh
chmod 700 /home/deploy/.ssh
chmod 600 /home/deploy/.ssh/authorized_keys
```

Verify `ssh deploy@<ip>` works in a separate terminal **before** running the lockdown:

```bash
sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#*PubkeyAuthentication.*/PubkeyAuthentication yes/' /etc/ssh/sshd_config
systemctl reload ssh
```

#### 2. Firewall (as root or `sudo`)

```bash
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
```

#### 3. Stack install (`sudo`)

```bash
apt update
apt install -y curl git build-essential ca-certificates gnupg ufw
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
apt install -y nodejs postgresql postgresql-contrib nginx
snap install --classic certbot
ln -sf /snap/bin/certbot /usr/bin/certbot
npm install -g pm2
```

#### 4. Database (as `deploy`, with sudo)

```bash
sudo -u postgres psql <<EOF
CREATE USER fpl WITH PASSWORD '<STRONG_PASSWORD>';
CREATE DATABASE "fpl-trends-db" OWNER fpl;
GRANT ALL PRIVILEGES ON DATABASE "fpl-trends-db" TO fpl;
EOF
```

Generate `<STRONG_PASSWORD>` with `openssl rand -base64 24` and save it.

#### 5. SSH key for GitHub (as `deploy`)

```bash
ssh-keygen -t ed25519 -C "deploy@fpl-trends-prod" -f ~/.ssh/github -N ""
cat ~/.ssh/github.pub
```

Add the printed public key at https://github.com/settings/keys.

```bash
cat > ~/.ssh/config <<'EOF'
Host github.com
  HostName github.com
  User git
  IdentityFile ~/.ssh/github
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config
```

#### 6. Clone + build the API (as `deploy`)

```bash
cd ~
git clone git@github.com:soseen/fpl-trends-api.git
cd fpl-trends-api
npm install

cat > .env <<EOF
DATABASE_URL="postgresql://fpl:<STRONG_PASSWORD>@localhost:5432/fpl-trends-db"
NODE_ENV=production
PORT=3000
ALLOWED_ORIGINS="https://fpltrends.live,https://www.fpltrends.live"
EOF

npm run bootstrap   # tsc + migrate + populate (first-time only)
```

#### 7. Run under pm2

```bash
pm2 start dist/server.js --name fpl-trends-api
pm2 save
pm2 startup systemd
# → run the printed `sudo env PATH=... pm2 startup systemd ...` command
pm2 save
```

Verify:

```bash
curl http://localhost:3000/api/totalPlayersCount   # → {"totalPlayers":...}
```

#### 8. Frontend build (as `deploy`)

```bash
cd ~
git clone git@github.com:soseen/fpl-trends-app.git
cd fpl-trends-app
echo 'API_BASE_URL=/api' > .env
npm install
npm run build
```

#### 9. nginx (`sudo`)

```bash
sudo tee /etc/nginx/sites-available/fpltrends.live > /dev/null <<'EOF'
server {
    listen 80;
    listen [::]:80;
    server_name fpltrends.live www.fpltrends.live;

    root /home/deploy/fpl-trends-app/dist;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 60s;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }

    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|woff2?)$ {
        expires 30d;
        add_header Cache-Control "public, immutable";
    }
}
EOF

sudo ln -sf /etc/nginx/sites-available/fpltrends.live /etc/nginx/sites-enabled/fpltrends.live
sudo rm -f /etc/nginx/sites-enabled/default
sudo chmod o+x /home/deploy
sudo chmod -R o+rX /home/deploy/fpl-trends-app/dist
sudo nginx -t
sudo systemctl reload nginx
```

#### 10. DNS (at registrar — currently Porkbun → Cloudflare)

| Type | Host | Value |
|---|---|---|
| A | `@` | `91.98.145.120` |
| A | `www` | `91.98.145.120` |
| AAAA | `@` | `2a01:4f8:c013:a22c::1` |
| AAAA | `www` | `2a01:4f8:c013:a22c::1` |

Wait until `nslookup fpltrends.live` resolves to the IP before running certbot.

#### 11. TLS (`sudo`)

```bash
sudo certbot --nginx -d fpltrends.live -d www.fpltrends.live
```

Certbot edits the nginx config in place to add the HTTPS server block + redirects. Certs auto-renew via the bundled systemd timer.

#### 12. Cron for populate (as `deploy`)

```bash
crontab -e
# Add:
*/30 * * * * cd /home/deploy/fpl-trends-api && /usr/bin/node dist/database/populateDatabase.js >> /home/deploy/populate.log 2>&1
```

(Or use the smart-cadence wrapper script — see [Data refresh](#data-refresh--populate).)

---

## Operating the production server

### Connect

```bash
ssh deploy@91.98.145.120
```

### Common pm2 commands

```bash
pm2 status                       # process list
pm2 logs fpl-trends-api          # tail logs
pm2 logs fpl-trends-api --err    # only stderr
pm2 restart fpl-trends-api       # restart after config change
pm2 reload fpl-trends-api        # zero-downtime reload
pm2 stop fpl-trends-api
pm2 delete fpl-trends-api
pm2 save                         # persist current process list
```

### Deploy a new version

```bash
ssh deploy@91.98.145.120
cd ~/fpl-trends-api && npm run deploy
pm2 logs fpl-trends-api --lines 30   # verify it came up
```

`npm run deploy` runs `git pull && npm install && npm run build && prisma migrate deploy && pm2 restart fpl-trends-api`. The migrate step is idempotent — safe to run every deploy. The populate step is **not** included; run `npm run populate` separately when you need to refresh data.

For first-time setup on a fresh server, use `npm run bootstrap` (`tsc + migrate + populate`).

### nginx changes

```bash
sudo nano /etc/nginx/sites-available/fpltrends.live
sudo nginx -t                    # syntax check
sudo systemctl reload nginx
```

### Database access

```bash
sudo -u postgres psql -d fpl-trends-db
# or
PGPASSWORD='<STRONG_PASSWORD>' psql -h localhost -U fpl -d fpl-trends-db
```

### Logs

| What | Where |
|---|---|
| API stdout/stderr | `pm2 logs fpl-trends-api` (also files under `~/.pm2/logs/`) |
| nginx access | `/var/log/nginx/access.log` |
| nginx error | `/var/log/nginx/error.log` |
| populate cron | `/home/deploy/populate.log` |
| Postgres | `/var/log/postgresql/` |
| auth/SSH | `journalctl -u ssh` |

---

## Data refresh / populate

`npm run populate` runs `tsx src/database/populateDatabase.ts`, which:

1. Fetches `bootstrap-static` (teams, events, all players' bulk fields).
2. Detects whether the FPL season has changed. If yes → wipes all game tables, clears cached JSON, stores the new season key.
3. Batch-fetches per-player summaries (32 players/batch, 60 ms delay, 3 retries with exponential backoff).
4. Upserts every table.

Each entrypoint that runs via `tsx` or compiled `node` loads `.env` automatically (`import "dotenv/config"` at the top of `populateDatabase.ts`, `resetSeason.ts`, `server.ts`). This means cron and pm2 don't need a sourced shell.

### Production cron

Simple version (every 30 minutes, all the time):

```cron
*/30 * * * * cd /home/deploy/fpl-trends-api && /usr/bin/node dist/database/populateDatabase.js >> /home/deploy/populate.log 2>&1
```

Smart cadence (every 30 minutes when matches are live, hourly otherwise):

```cron
*/30 * * * * /home/deploy/fpl-trends-api/scripts/smart-populate.sh >> /home/deploy/populate.log 2>&1
```

The wrapper script decides whether to actually trigger populate based on whether any fixture is currently in progress (kickoff < now < kickoff + 2.5h). Keep the cron tick at `*/30` and let the script self-skip on the off-half-hour outside game windows.

### Manual populate

```bash
cd ~/fpl-trends-api
npm run populate
```

---

## Manager rank estimation (My Trends)

The `/api/manager/:id/range-rank` endpoint returns an estimate of where a manager would rank if FPL re-ranked everyone using only the points scored within a chosen gameweek range. There's no FPL API for "rank in GW range X–Y", so we approximate it from a stratified sample of managers' per-GW points cached in `manager_history`.

### How the estimate is computed

For an incoming request:

1. Fetch the user live from FPL: `GET /entry/{id}/` and `GET /entry/{id}/history/`.
2. Compute `userRangeTotal = Σ (points − event_transfers_cost)` over each GW in `[start, end]`.
3. Resolve `STRATUM_C_MAX` dynamically as `MAX(events.ranked_count)` over finished GWs (currently ~12.6M and growing through the season).
4. For each of the three strata, run a single SQL aggregate against `manager_history` to count how many *sampled* managers in that stratum scored ≥ `userRangeTotal` over the range.
5. Treat each stratum as a Bernoulli urn: extrapolate `higher_in_sample × STRATUM_TRUE_SIZE / total_probes` per stratum, then sum across all three. The denominator is **total probes** (active + inactive + trolling + fetch_failed), not the active subset — inactives' deleted-or-zero history sits below threshold and contributes to the denominator without inflating the numerator.
6. **Cap** the final value at `events.ranked_count[endGw]`. Especially relevant for early-season ranges (only ~5.7M had ranks after GW 7).

This replaced the older "scale within current stratum + flat 100k offset for strata above" approach (commits `820920d`, `023c25e`). Two head-to-head test cases against official FPL after the change:

| Range | Pre-fix output | Final output | Official |
|---|---|---|---|
| GW 1–7 | 2,187,021 (+57%) | ≈ 1,420k–1,460k | 1,424,951 |
| GW 1–15 | 751,000 (+73%) | ≈ 420k–460k | 434,000 |

### Strata

| Stratum | Overall rank band | Sampling | Typical scaling factor |
|---|---|---|---|
| A | 1 – 10,000 | full census via standings pages 1–200 | ~1× |
| B | 10,001 – 100,000 | every 5th page from 201–2000 (1-in-5) | ~5× |
| C | 100,001 – `MAX(events.ranked_count)` | random ID probing in `[1, 15,000,000]`, filtered to C range | depends on probe count (~1000–2500×) |
| — | beyond `MAX(events.ranked_count)` | not addressable — endpoint returns the user's overall rank with `confidence: "approximate"` | — |

`STRATUM_C_MAX` is dynamic. We previously hard-coded 10.4M, but FPL's ranked tail grows through the season — anyone past the static bound was silently un-rankable. Reading from `events.ranked_count` keeps stratum 3 sized to the actual population without redeploying every few weeks.

### Activity / troll filter

Each candidate's history is classified before insertion (see `src/managers/activityFilter.ts`):

- **inactive** — no transfers (`event_transfers === 0`) across the most recent 8 finished GWs.
- **trolling** — total `event_transfers_cost` > 60 across the season, OR any single GW with cost ≥ 20 (5+ extra hits).
- **active** — anything else.

The flag is recorded on `manager_summary.rejected_reason`, but per-GW history is **kept for every classification**. That's the change that fixed the 35% GW1–5 undercount — currently-inactive managers who scored well early were invisible to the rank count when their history was deleted.

> **Why keep troll history too?** A "trolling" manager's net points (`points − event_transfers_cost`) is normal-or-below — a -20 hit cost in one GW pulls net *down*, not up. They don't systematically beat anyone, and forcibly excluding them via `rejected_reason` would re-introduce a small undercount. The flag still gates *comparison-average* queries (hits/bench) where a single 60-hit account would skew the mean.

### Defensive ingestion

`src/database/populateManagers.ts` runs the sampler. It's designed to stay polite to the FPL API — there's no published rate limit, but we treat it as ~25 req/s sustainable.

- **Concurrency**: batches of 8 concurrent fetches with a 300ms inter-batch delay (~25 req/s).
- **Per-run cap**: at most **5,000 managers per invocation**. Each cron tick is short (~3.5 min) and resumes from a persistent cursor stored in `app_metadata`.
- **Adaptive backoff** (`src/managers/rateLimitGovernor.ts`): on `429` / `503`, pause 5 minutes and double the inter-batch delay (honoring `Retry-After` if present). On timeout / `ECONNRESET`, pause 2 minutes. After 3 consecutive errors the run aborts cleanly and exits — cron will retry next tick.
- **User-Agent** header identifies the app: `fpl-trends/1.0 (+https://fpltrends.live)` so FPL admins can throttle politely rather than IP-ban.
- **Lockfile** at `<os.tmpdir()>/fpl-populate-managers.lock` prevents overlapping cron runs.

### What `processEntry` does per manager

For each manager touched in a run (5000/run cap):

1. **Skip** if `last_checked_gw === currentGw` (already processed this GW).
2. Fetch `/entry/{id}/history/` once → upsert `manager_summary` (with `rejected_reason` from the classifier) → upsert one `manager_history` row per GW (covers `points`, `event_transfers`, `event_transfers_cost`, `points_on_bench`).
3. Inline picks ingestion: if `manager_picks(entry_id, currentGw)` is missing, fetch `/entry/{id}/event/{currentGw}/picks/` and upsert. **Only the latest finished GW** — historical depth is the [picks backfill](#backfill-scripts-one-off)'s job. Keeping inline calls bounded to one extra request per manager keeps the cron predictable (~5k extra calls per run regardless of backfill state).

### Budget allocation per run

Each invocation allocates the 5,000-entry budget across strata that still have work:

```
budget A (if not fully covered) = 2,500
budget B (if not fully covered) = 1,500
budget C (always)               = remainder (1,000–5,000)
```

Stratum C is intentionally always given budget so the deep tail starts to fill from day one rather than waiting for A and B to complete.

### Cursors stored in `app_metadata`

| Key | Tracks |
|---|---|
| `manager_ingest_cursor_a` | Next page (1–200) for stratum A's standings walk |
| `manager_ingest_cursor_b` | Next page (201–2000, advancing by 5) for stratum B |
| _none for C_ | Stratum C uses random probing in `[1, 15_000_000]` — no cursor; just keeps probing |

When stratum A or B is fully covered, its cursor wraps back to its start page so the sample refreshes over time.

### Manual run

```bash
npm run populate-managers
```

Each invocation processes ≤ 5,000 entries then exits. Re-run as many times as you like; the cursor advances each time.

### Production cron (recommended)

Every 15 minutes — each run is short, polite, and self-limited:

```cron
*/15 * * * * cd /home/deploy/fpl-trends-api && /usr/bin/node dist/database/populateManagers.js >> /home/deploy/populate-managers.log 2>&1
```

For a cold-start (fresh server), expect ~12 hours of wall time spread across the day before the sample is dense enough to give `confidence: "estimated"` for the median user. Stratum A converges to `confidence: "exact"` after 2–3 runs.

When a new GW finishes, the `last_checked_gw === currentGw` skip releases — over the next ~75 min (5k managers/run × 4 runs/hour) the entire sample gets re-processed and each manager's new-GW picks land in `manager_picks`.

### Inspecting the sample

```sql
-- How big is each stratum (active only)?
SELECT stratum, COUNT(*) AS active
FROM manager_summary
WHERE rejected_reason IS NULL
GROUP BY stratum;

-- Reject reasons distribution
SELECT rejected_reason, COUNT(*)
FROM manager_summary
GROUP BY rejected_reason;

-- Total probes per stratum (denominator the rank calc uses)
SELECT stratum, COUNT(*) AS total_probes
FROM manager_summary
GROUP BY stratum;

-- Picks coverage per stratum (how far along is the picks backfill?)
SELECT ms.stratum, COUNT(DISTINCT ms.entry_id) AS managers,
       COUNT(mp.entry_id) AS picks_rows
FROM manager_summary ms
LEFT JOIN manager_picks mp ON mp.entry_id = ms.entry_id
GROUP BY ms.stratum;
```

---

## Manager comparison (sample averages + top 10k)

`/api/manager/:id/comparison?start=X&end=Y` returns the user's stats next to two reference columns: the overall sample average (active managers across all strata) and the **top 10k** average (stratum 1 only — full census, so a direct measurement, not extrapolated).

### Stats returned

| Stat | User-side source | Sample / top-10k source |
|---|---|---|
| **Total points** | sum of `netPointsForEvent(ev)` over range | `AVG(SUM(mh.points))` per manager in stratum |
| **Avg GW score** | range total ÷ GWs in range | `AVG(AVG(mh.points))` per manager — mean of per-manager means |
| **Captain bonus** | per-GW picks fetch from FPL × captain GW points × `(multiplier − 1)` | `manager_picks ⨝ history` join, sum per manager, average across stratum |
| **Most captained** | mode of captain elements across the range | mode of `mp.captain_element` across the stratum sample |
| **Transfers made** | sum of `event_transfers` from FPL history | `AVG(SUM(mh.event_transfers))` per manager |
| **Wildcards / Free hits / Bench boosts** | did the user play it in range? (0 / 1) | overall avg falls back to `events.chip_plays` rates; top-10k uses `manager_picks.active_chip` |
| **Hits taken** | sum of `floor(event_transfers_cost / 4)` | `AVG(SUM(event_transfers_cost) / 4)` per manager |
| **Points benched** | sum of `points_on_bench` | `AVG(SUM(points_on_bench))` per manager |

### Captain stats (user-side)

Per query, we fetch `/entry/{id}/event/{gw}/picks/` for each GW in the requested range. To stay under the frontend's 8s timeout we batch in groups of 6 with a 60ms inter-batch delay (38 GWs ≈ 1.5–2 s of API time). Each successful payload yields the captain element + multiplier. The captain's GW points come from our local `history` table (sums all rows for the round in case of a double-GW), and we tally the captain element across the range to surface "most captained" as a player name.

If a single GW's picks call fails, we skip it — the bonus is undercounted by that GW only. The whole endpoint stays reliable because we don't await every call sequentially.

### Captain stats (sample / top-10k)

A single SQL query per stratum scope, with a `LEFT JOIN LATERAL` to sum the captain's GW points from `history`:

```sql
SELECT AVG(t.bonus_per_manager)::float, COUNT(*)::int
FROM (
  SELECT mp.entry_id,
    SUM(
      COALESCE(gw_pts.pts, 0)
      * GREATEST(COALESCE(mp.captain_multiplier, 1) - 1, 0)
    )::float AS bonus_per_manager
  FROM manager_picks mp
  JOIN manager_summary ms ON ms.entry_id = mp.entry_id
  LEFT JOIN LATERAL (
    SELECT SUM(h.total_points)::int AS pts
    FROM history h
    WHERE h.footballer_id = mp.captain_element AND h.round = mp.gw
  ) gw_pts ON TRUE
  WHERE mp.gw BETWEEN $1 AND $2
    AND ms.rejected_reason IS NULL
    [AND ms.stratum = 1 for top-10k]
  GROUP BY mp.entry_id
) t
```

`GREATEST(multiplier − 1, 0)` zeros out the contribution when the captain ended up benched (`multiplier = 0`).

### Coverage gating

For columns built on per-manager `manager_history` fields (hits, bench, transfers), we only surface the average if **at least 50% of the sample has non-null data** for that field. Backfills can leave this partially populated for a few hours; `notes.hits_average_partial` / `bench_average_partial` / `captain_average_partial` flags let the UI render an `≈` prefix instead of a misleadingly precise number.

### Why top-10k is "current top 10k", not "top 10k after GW X"

Reconstructing per-GW historical leaderboards for 10k+ managers is impractical without storing ranks per GW. We use the *currently* top-10k cohort as the reference, which is — empirically — close to "best-of-season" for medium ranges and skews slightly toward "best-late-season" for short early ranges. For the comparison-table use case (i.e. "how do I stack up against the elite right now") this is the right framing.

---

## Backfill scripts (one-off)

Two `npm run` scripts cover gaps the regular cron can't fill on its own.

### `npm run backfill-nonactive-history`

Re-fetches `/entry/{id}/history/` for managers classified inactive/trolling under the **pre-fix** code path that deleted their history rows. Idempotent — selects only entries with zero existing `manager_history` rows.

- Run once after deploying the rank-undercount fix.
- ~3–5 minutes wall-clock for a typical sample size.
- Safe to interrupt and resume.

```bash
npm run backfill-nonactive-history
```

After this completes, future inactive/troll classifications keep their history automatically — no need to re-run.

### `npm run backfill-picks`

Walks every `(entry_id, gw)` pair in the sample where `manager_picks` is missing, fetching `/entry/{id}/event/{gw}/picks/` and upserting. Walks stratum 1 → 2 → 3 so the comparison table's top-10k column lights up first.

- Run once after the schema migration adds `manager_picks`.
- ~9 hours wall-clock at sustained ~25 req/s for a fully-sampled production DB (~25k managers × ~33 finished GWs).
- Run in the background: `nohup npm run backfill-picks > backfill-picks.log 2>&1 &`.
- Resumable; safe to kill and restart.

```bash
nohup npm run backfill-picks > backfill-picks.log 2>&1 &
tail -f backfill-picks.log    # progress every 500 (manager, GW) pairs
```

After this completes, the regular `populate-managers` cron handles every subsequent GW transition — managers' new-GW picks ingest inline once the GW becomes finished. Re-running `backfill-picks` is only necessary if you significantly expand the sample (e.g. bump `STRATUM_C_ID_MAX` and want to retroactively fill picks for newly-eligible managers).

### Order of operations after a release that touches both layers

```bash
ssh deploy@91.98.145.120
cd ~/fpl-trends-api && npm run deploy            # pulls, builds, runs prisma migrate deploy, restarts pm2
npm run backfill-nonactive-history               # ~3–5 min
nohup npm run backfill-picks > backfill-picks.log 2>&1 &   # ~9 h background
cd ~/fpl-trends-app && npm run deploy            # frontend
```

---

## Start-of-season runbook

When a new Premier League season begins (typically mid-August), the FPL API resets to the new season. The system **should** detect this automatically on the next populate, but here's the manual path if it doesn't.

### Automatic path (preferred)

Just wait for the next scheduled populate. `seasonManager.ts` derives the season from the first event's deadline year (e.g. an Aug 2026 first deadline → season `"2026-27"`) and compares it to `app_metadata.current_season`. On mismatch:

1. All game data tables are truncated (`footballers`, `history`, `footballer_fixtures`, `teams`, `team_history`, `events`, plus `manager_history` and `manager_summary` since they're season-scoped).
2. Cached JSON files in `src/data/` are deleted.
3. The new season key is stored.
4. A fresh populate runs.

You'll see this in the populate logs:

```
🆕 Season change detected: 2025-26 → 2026-27. Wiping…
✓ All game data tables wiped
✓ Cached JSON deleted
✓ New season identifier stored
Populating teams…  …  ✅ Database populated successfully!
```

### Manual path (fallback)

If detection misses (rare — usually only if FPL changed their data shape), force a clean slate:

```bash
ssh deploy@91.98.145.120
cd ~/fpl-trends-api
npm run reset-season   # truncates all game tables + clears season key
npm run populate       # re-fetches everything from FPL API
pm2 restart fpl-trends-api
```

### Things to double-check at start of season

1. **CORS** — confirm `ALLOWED_ORIGINS` in `~/fpl-trends-api/.env` still matches the live domain.
2. **Front-end env** — confirm `~/fpl-trends-app/.env` still has `API_BASE_URL=/api`.
3. **Cron** — `crontab -l` should still show the populate entry.
4. **TLS** — certs renew automatically via certbot's systemd timer; if you want to be sure: `sudo certbot certificates`.
5. **Disk** — `df -h /` (FPL data is small, but logs grow).
6. **Bundle freshness** — if any client-side code referencing player IDs/positions changed mid-summer, rebuild the frontend (`cd ~/fpl-trends-app && git pull && npm run build`).

---

## Troubleshooting

### Populate fails with `Environment variable not found: DATABASE_URL`

Each entrypoint already loads dotenv, but if you've added a new tsx-run script, add `import "dotenv/config";` as the first line.

Workaround in any shell session:

```bash
set -a; source .env; set +a
npm run populate
```

### `pm2 status` shows API as `errored`

```bash
pm2 logs fpl-trends-api --err --lines 100
```

Most common causes: DB connection refused (Postgres not running, or password wrong), port 3000 already taken, missing `.env`.

### Frontend loads but XHR calls fail with `ERR_CONNECTION_REFUSED`

The bundle is hardcoded with the wrong `API_BASE_URL`. Rebuild with `API_BASE_URL=/api` so the browser calls the same origin (nginx then proxies `/api/` → port 3000).

### `nginx -t` reports config OK but site shows "403 Forbidden"

nginx (running as `www-data`) can't traverse `/home/deploy`. Fix:

```bash
sudo chmod o+x /home/deploy
sudo chmod -R o+rX /home/deploy/fpl-trends-app/dist
```

### TLS cert renew failure

```bash
sudo certbot renew --dry-run
sudo certbot renew --force-renewal
sudo systemctl reload nginx
```

### "Most recent populate stopped halfway"

The FPL API is occasionally flaky during gameweeks. Re-run `npm run populate`. The script is idempotent (everything is upsert-by-id).

---

## Known issues

1. **No automated data refresh inside the Node process** — relies on system cron in production.
2. **Database credentials live in `.env`** — gitignored, but plaintext on disk.
3. **No authentication** on any endpoint.
4. **No rate limiting** on any endpoint.
5. **No health check endpoint.**
6. **Manager rank precision degrades with overall rank** — top 10k is exact (full census). Stratum 2 (10k–100k) is sampled 1-in-5 and contributes near-direct measurement. Stratum 3 (100k–`MAX(events.ranked_count)`) extrapolates ~1000–2500× per probe and so carries the bulk of the variance; expect ±5–10% on the final number while the sample is fresh.
7. **Manager rank ingestion is unverified at scale on the production IP** — the FPL API has no published rate limit; the governor handles 429/503 gracefully but a sustained ban would require routing ingestion through a separate egress.
8. **Picks backfill is heavy** — ~9 hours for a fully-sampled production DB. Can't be parallelised across processes (single lockfile). Kicking off with `nohup` and tailing the log is the recommended pattern.
9. **`stratum` on `manager_summary` is whatever it was at last classification** — a manager who climbed from stratum 3 to stratum 2 since their last cron pass still appears under stratum 3 in queries until re-encountered. Small drift; not corrected because comparison/rank queries treat strata as roughly-equal-density buckets.
