-- Persistent full-match lifecycle reliability monitoring.
-- Tracks whether real fixtures make it through prediction, live, settlement and learning stages.

CREATE TABLE IF NOT EXISTS lifecycle_reliability_fixtures (
  fixture_id INTEGER PRIMARY KEY,
  league_id INTEGER,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_at TIMESTAMP NOT NULL,
  enrolled_at TIMESTAMP NOT NULL DEFAULT NOW(),
  first_checkpoint TEXT,
  lifecycle_status TEXT NOT NULL DEFAULT 'collecting',
  reliability_score REAL,
  completion_pct REAL,
  verdict TEXT NOT NULL DEFAULT 'collecting',
  missing_required_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  advisory_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage_json JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_evaluated_at TIMESTAMP,
  completed_at TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_reliability_kickoff
  ON lifecycle_reliability_fixtures(kickoff_at DESC);
CREATE INDEX IF NOT EXISTS idx_lifecycle_reliability_verdict
  ON lifecycle_reliability_fixtures(verdict, kickoff_at DESC);

CREATE TABLE IF NOT EXISTS lifecycle_reliability_runs (
  id BIGSERIAL PRIMARY KEY,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  fixtures_evaluated INTEGER NOT NULL DEFAULT 0,
  collecting_count INTEGER NOT NULL DEFAULT 0,
  passed_count INTEGER NOT NULL DEFAULT 0,
  warning_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  football_quota_json JSONB,
  odds_quota_json JSONB,
  audit_worker_json JSONB,
  market_sampler_json JSONB,
  error_message TEXT
);

CREATE INDEX IF NOT EXISTS idx_lifecycle_reliability_runs_recent
  ON lifecycle_reliability_runs(started_at DESC);
