# fpl-trends-api

Backend for **FPL Trends** (https://fpltrends.live) — a Fantasy Premier League analytics platform.

Fetches data from the official FPL API, stores it in PostgreSQL via Prisma, and exposes it through a small REST API consumed by [`fpl-trends-app`](https://github.com/soseen/fpl-trends-app).

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
10. [Start-of-season runbook](#start-of-season-runbook)
11. [Troubleshooting](#troubleshooting)
12. [Known issues](#known-issues)

---

## Overview

The API has three responsibilities:

1. **Ingest** data from the official FPL API (`https://fantasy.premierleague.com/api/...`) — players, teams, fixtures, gameweek events, per-match history.
2. **Store** it in PostgreSQL using Prisma migrations as the source of truth for schema.
3. **Serve** a small set of REST endpoints to the SPA frontend.

Ingest is **manual** — there's no scheduler in the Node process itself. In production we rely on a system **cron** to call the populate script on a schedule (see [Data refresh](#data-refresh--populate)).

The system is **season-aware**: every populate run detects whether the FPL season has changed (by reading the first event's deadline year and comparing it against `app_metadata.current_season` in the DB). On change, all game data tables are wiped and re-populated from scratch.

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

7 tables, all defined in `prisma/schema.prisma`.

| Table | Purpose | Key fields |
|---|---|---|
| `app_metadata` | Application state KV store | `key`, `value` (currently stores `current_season` like `"2025-26"`) |
| `footballers` | Player data (~100+ columns) | `id`, `web_name`, `team_id`, `now_cost`, `total_points`, `xG`, `xA`, `xGI`, `ICT`, `form`, `status`, per-90 variants |
| `history` | Per-match player stats | composite PK `(footballer_id, fixture_id)`, `total_points`, goals, assists, xG, xGI, xGC, minutes, opponent |
| `footballer_fixtures` | Upcoming fixtures per player | `footballer_id`, `fixture_id`, `difficulty`, `is_home`, `team_h`, `team_a` |
| `teams` | Club data + strength ratings | `id`, `name`, `short_name`, `strength_*` (attack/defence × home/away) |
| `team_history` | Aggregated team stats per GW | composite PK `(team_id, round)`, `teamXGS`, `teamXGC`, `goals`, `goals_conceded` |
| `events` | Gameweek metadata | `id`, `name`, `finished`, `is_current`, `deadline_time`, `most_selected`, `top_element` |

Cascade delete is set on the `footballers → history`, `footballers → footballer_fixtures`, and `teams → team_history` relations.

---

## API endpoints

All endpoints are public (no auth). CORS allowlist is hardcoded in `src/server.ts`.

| Method | Path | Returns |
|---|---|---|
| `GET` | `/api/footballersData` | All players with team, history, and fixtures (Prisma `include`) |
| `GET` | `/api/teamsData` | All teams with `team_history` |
| `GET` | `/api/totalPlayersCount` | `{ totalPlayers: number }` |
| `GET` | `/api/eventsData` | Gameweek events |
| `GET` | `/api/populate` | Triggers a full data refresh from the FPL API |

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
cd ~/fpl-trends-api
git pull
npm install                       # if package.json changed
npm run build                     # tsc only — does NOT populate
npx prisma migrate deploy         # apply any new migrations
pm2 restart fpl-trends-api
pm2 logs fpl-trends-api --lines 30
```

`npm run build` is compile-only. Use `npm run bootstrap` only for first-time setup on a fresh server (it also runs migrate + populate).

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

## Start-of-season runbook

When a new Premier League season begins (typically mid-August), the FPL API resets to the new season. The system **should** detect this automatically on the next populate, but here's the manual path if it doesn't.

### Automatic path (preferred)

Just wait for the next scheduled populate. `seasonManager.ts` derives the season from the first event's deadline year (e.g. an Aug 2026 first deadline → season `"2026-27"`) and compares it to `app_metadata.current_season`. On mismatch:

1. All 6 game data tables are truncated (`footballers`, `history`, `footballer_fixtures`, `teams`, `team_history`, `events`).
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
