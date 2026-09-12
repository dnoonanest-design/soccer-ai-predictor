-- Immutable prediction accuracy audit records.
-- Each row represents the model output at a fixed pre-match or in-play checkpoint.
-- Rows are settled later against match_outcomes so model versions can be compared
-- without overwriting the prediction that was actually available at the time.

CREATE TABLE IF NOT EXISTS prediction_audit_records (
  id BIGSERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_at TIMESTAMP,
  phase TEXT NOT NULL CHECK (phase IN ('prematch', 'live')),
  checkpoint TEXT NOT NULL,
  minute INTEGER,
  data_tier TEXT NOT NULL DEFAULT 'stats',
  model_version TEXT NOT NULL,
  engine_revision TEXT NOT NULL DEFAULT 'unknown',
  home_win_prob REAL NOT NULL,
  draw_prob REAL NOT NULL,
  away_win_prob REAL NOT NULL,
  over25_prob REAL,
  btts_prob REAL,
  home_xg REAL,
  away_xg REAL,
  confidence REAL,
  pick_confidence REAL NOT NULL,
  confidence_band TEXT NOT NULL,
  predicted_outcome TEXT NOT NULL CHECK (predicted_outcome IN ('home', 'draw', 'away')),
  circumstance_score_home REAL,
  circumstance_score_away REAL,
  home_form_score REAL,
  away_form_score REAL,
  actual_outcome TEXT CHECK (actual_outcome IS NULL OR actual_outcome IN ('home', 'draw', 'away')),
  score_home INTEGER,
  score_away INTEGER,
  correct BOOLEAN,
  brier_score REAL,
  log_loss REAL,
  over25_actual BOOLEAN,
  btts_actual BOOLEAN,
  over25_correct BOOLEAN,
  btts_correct BOOLEAN,
  captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMP,
  CONSTRAINT uniq_prediction_audit_checkpoint
    UNIQUE(fixture_id, checkpoint, model_version, engine_revision)
);

CREATE INDEX IF NOT EXISTS idx_prediction_audit_pending
  ON prediction_audit_records(settled_at, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_audit_league
  ON prediction_audit_records(league_id, settled_at, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_audit_model
  ON prediction_audit_records(model_version, engine_revision, settled_at, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prediction_audit_checkpoint
  ON prediction_audit_records(checkpoint, settled_at, captured_at DESC);
