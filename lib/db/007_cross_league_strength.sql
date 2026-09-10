CREATE TABLE IF NOT EXISTS team_strength_rating_history (
  id BIGSERIAL PRIMARY KEY,
  team_id INTEGER NOT NULL,
  domestic_league_id INTEGER,
  league_rating REAL NOT NULL,
  club_rating REAL NOT NULL,
  schedule_rating REAL NOT NULL,
  uncertainty REAL NOT NULL,
  matches_used INTEGER NOT NULL,
  source TEXT NOT NULL,
  model_version TEXT NOT NULL,
  evidence_through TIMESTAMP NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_team_strength_evidence UNIQUE (team_id, model_version, evidence_through)
);

CREATE INDEX IF NOT EXISTS idx_team_strength_latest
  ON team_strength_rating_history(team_id, evidence_through DESC, created_at DESC);

COMMENT ON TABLE team_strength_rating_history IS
  'Versioned, time-valid club and league strength profiles. Only evidence strictly earlier than a prediction may be read.';

ALTER TABLE prediction_audit_records
  ADD COLUMN IF NOT EXISTS strength_rating_gap REAL,
  ADD COLUMN IF NOT EXISTS cross_league_prior_weight REAL,
  ADD COLUMN IF NOT EXISTS strength_model_version TEXT;

CREATE INDEX IF NOT EXISTS idx_prediction_audit_strength_gap
  ON prediction_audit_records(strength_rating_gap, settled_at, captured_at DESC);
