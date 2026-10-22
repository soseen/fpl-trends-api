-- New season-scoped data only. No historical facts are rewritten or removed.
CREATE TABLE analytics_benchmarks (
  id UUID PRIMARY KEY,
  season VARCHAR(10) NOT NULL,
  gw INTEGER NOT NULL CHECK (gw BETWEEN 1 AND 38),
  calculation_version INTEGER NOT NULL,
  source_revision TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analytics_benchmarks_scope_idx ON analytics_benchmarks(season, gw, created_at DESC);
CREATE TABLE analytics_publications (
  season VARCHAR(10) NOT NULL,
  gw INTEGER NOT NULL CHECK (gw BETWEEN 1 AND 38),
  benchmark_id UUID NOT NULL REFERENCES analytics_benchmarks(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(season, gw)
);
CREATE TABLE analytics_jobs (
  id UUID PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,
  kind VARCHAR(20) NOT NULL CHECK (kind IN ('benchmark','manager')),
  season VARCHAR(10) NOT NULL,
  entry_id INTEGER,
  start_gw INTEGER NOT NULL CHECK (start_gw BETWEEN 1 AND 38),
  end_gw INTEGER NOT NULL CHECK (end_gw BETWEEN start_gw AND 38),
  status VARCHAR(20) NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','succeeded','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  available_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  lease_token UUID,
  lease_until TIMESTAMPTZ,
  heartbeat_at TIMESTAMPTZ,
  error_code TEXT,
  error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX analytics_jobs_queue_idx ON analytics_jobs(status, kind, available_at);
CREATE INDEX analytics_jobs_entry_idx ON analytics_jobs(season, entry_id, status);
CREATE TABLE analytics_manager_results (
  season VARCHAR(10) NOT NULL,
  entry_id INTEGER NOT NULL,
  start_gw INTEGER NOT NULL,
  end_gw INTEGER NOT NULL,
  revision TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY(season, entry_id, start_gw, end_gw)
);
CREATE INDEX analytics_manager_results_expiry_idx ON analytics_manager_results(expires_at);
CREATE TABLE analytics_manager_sources (
  season VARCHAR(10) NOT NULL,
  entry_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload JSONB NOT NULL,
  finalized BOOLEAN NOT NULL DEFAULT false,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY(season,entry_id,kind)
);
CREATE INDEX analytics_manager_sources_fetched_idx ON analytics_manager_sources(fetched_at);
