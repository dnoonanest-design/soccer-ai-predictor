-- Prediction platform database upgrade.
-- Run this once against Postgres before using the new tracking/training/live features.

-- Base prediction result tables used by calibration, accuracy and training.
CREATE TABLE IF NOT EXISTS match_predictions (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  league_id INTEGER,
  home_win_prob REAL NOT NULL,
  draw_prob REAL NOT NULL,
  away_win_prob REAL NOT NULL,
  is_live BOOLEAN NOT NULL DEFAULT FALSE,
  model_version TEXT NOT NULL DEFAULT 'v1',
  kickoff_at TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_fixture_live UNIQUE(fixture_id, is_live)
);

CREATE TABLE IF NOT EXISTS match_outcomes (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL UNIQUE,
  outcome TEXT NOT NULL CHECK (outcome IN ('home', 'draw', 'away')),
  score_home INTEGER NOT NULL,
  score_away INTEGER NOT NULL,
  recorded_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS prediction_snapshots (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  minute INTEGER,
  status TEXT NOT NULL,
  home_win_prob REAL NOT NULL,
  draw_prob REAL NOT NULL,
  away_win_prob REAL NOT NULL,
  over25_prob REAL,
  btts_prob REAL,
  home_xg REAL,
  away_xg REAL,
  pressure_home REAL,
  pressure_away REAL,
  next_goal_home REAL,
  next_goal_away REAL,
  confidence REAL,
  model_version TEXT NOT NULL DEFAULT 'v2-statistical',
  reasons_json TEXT,
  value_edges_json TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_fixture ON prediction_snapshots(fixture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bet_tracker (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  decimal_odds REAL NOT NULL,
  stake NUMERIC(12,2) NOT NULL DEFAULT 1.00,
  model_prob REAL,
  edge_pct REAL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'won', 'lost', 'void')),
  profit NUMERIC(12,2),
  notes TEXT,
  placed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  settled_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_bet_tracker_status ON bet_tracker(status, placed_at DESC);

CREATE TABLE IF NOT EXISTS model_training_runs (
  id SERIAL PRIMARY KEY,
  model_version TEXT NOT NULL,
  training_rows INTEGER NOT NULL,
  holdout_rows INTEGER NOT NULL,
  pick_accuracy REAL,
  brier_score REAL,
  roi_pct REAL,
  weights_json TEXT NOT NULL,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS live_alerts (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  alert_type TEXT NOT NULL,
  team_side TEXT,
  minute INTEGER,
  pressure_score REAL,
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_live_alerts_fixture ON live_alerts(fixture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS app_users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  plan TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS user_watchlist (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  fixture_id INTEGER NOT NULL,
  alert_rules TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_user_fixture_watch UNIQUE(user_id, fixture_id)
);


-- Background learner deep-stat storage and automatic calibration.
CREATE TABLE IF NOT EXISTS deep_match_stats (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  status TEXT NOT NULL,
  minute INTEGER,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  score_home INTEGER,
  score_away INTEGER,
  home_xg REAL,
  away_xg REAL,
  home_momentum REAL,
  away_momentum REAL,
  next_goal_home REAL,
  next_goal_away REAL,
  home_shots INTEGER,
  away_shots INTEGER,
  home_shots_on_target INTEGER,
  away_shots_on_target INTEGER,
  home_corners INTEGER,
  away_corners INTEGER,
  home_red_cards INTEGER,
  away_red_cards INTEGER,
  raw_stats_json JSONB,
  collected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_deep_stats_fixture_minute UNIQUE(fixture_id, minute, status)
);
CREATE INDEX IF NOT EXISTS idx_deep_match_stats_fixture ON deep_match_stats(fixture_id, collected_at DESC);
CREATE INDEX IF NOT EXISTS idx_deep_match_stats_collected ON deep_match_stats(collected_at DESC);

CREATE TABLE IF NOT EXISTS background_job_runs (
  id SERIAL PRIMARY KEY,
  job_name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  checked_count INTEGER NOT NULL DEFAULT 0,
  changed_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  started_at TIMESTAMP NOT NULL DEFAULT NOW(),
  finished_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_background_job_runs_recent ON background_job_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS calibration_parameters (
  id SERIAL PRIMARY KEY,
  model_version TEXT NOT NULL,
  sample_size INTEGER NOT NULL,
  factors_json JSONB NOT NULL,
  metrics_json JSONB NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_calibration_parameters_active ON calibration_parameters(active, created_at DESC);

-- Circumstance learning: lineups, injuries, star-player impact, cards, form and player performance.
CREATE TABLE IF NOT EXISTS match_circumstances (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL UNIQUE,
  league_id INTEGER,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  status TEXT NOT NULL,
  minute INTEGER,
  home_formation TEXT,
  away_formation TEXT,
  home_starting_xi_count INTEGER,
  away_starting_xi_count INTEGER,
  home_missing_players INTEGER,
  away_missing_players INTEGER,
  home_starters_out INTEGER,
  away_starters_out INTEGER,
  home_yellow_cards INTEGER,
  away_yellow_cards INTEGER,
  home_red_cards INTEGER,
  away_red_cards INTEGER,
  home_in_match_injuries INTEGER,
  away_in_match_injuries INTEGER,
  home_goal_contribution_players INTEGER,
  away_goal_contribution_players INTEGER,
  home_avg_player_rating REAL,
  away_avg_player_rating REAL,
  home_star_player_rating REAL,
  away_star_player_rating REAL,
  home_form_score REAL,
  away_form_score REAL,
  circumstance_score_home REAL,
  circumstance_score_away REAL,
  raw_lineups_json JSONB,
  raw_injuries_json JSONB,
  raw_players_json JSONB,
  raw_events_json JSONB,
  collected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_match_circumstances_fixture ON match_circumstances(fixture_id);
CREATE INDEX IF NOT EXISTS idx_match_circumstances_league ON match_circumstances(league_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS player_match_factors (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  team_side TEXT NOT NULL,
  team_name TEXT NOT NULL,
  player_id INTEGER,
  player_name TEXT NOT NULL,
  role TEXT,
  position TEXT,
  starter BOOLEAN,
  captain BOOLEAN,
  rating REAL,
  minutes INTEGER,
  goals INTEGER,
  assists INTEGER,
  shots INTEGER,
  key_passes INTEGER,
  yellow_cards INTEGER,
  red_cards INTEGER,
  injured_during_match BOOLEAN NOT NULL DEFAULT FALSE,
  missing_before_match BOOLEAN NOT NULL DEFAULT FALSE,
  influence_score REAL,
  raw_json JSONB,
  collected_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_player_match_factor UNIQUE(fixture_id, team_side, player_name)
);
CREATE INDEX IF NOT EXISTS idx_player_match_factors_fixture ON player_match_factors(fixture_id);
CREATE INDEX IF NOT EXISTS idx_player_match_factors_player ON player_match_factors(player_name, collected_at DESC);

CREATE TABLE IF NOT EXISTS factor_learning_insights (
  id SERIAL PRIMARY KEY,
  factor_name TEXT NOT NULL,
  factor_group TEXT NOT NULL,
  league_id INTEGER,
  sample_size INTEGER NOT NULL,
  win_rate_when_positive REAL,
  win_rate_when_negative REAL,
  avg_goal_diff_impact REAL,
  correlation REAL,
  learned_weight REAL,
  confidence REAL,
  notes TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_factor_learning_active ON factor_learning_insights(active, factor_name, created_at DESC);

-- AI-aware predictor memory, similar-match learning and guarded self-improvement.
CREATE TABLE IF NOT EXISTS similar_match_memory (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  match_signature TEXT NOT NULL,
  feature_vector_json JSONB NOT NULL,
  predicted_outcome TEXT,
  actual_outcome TEXT,
  predicted_home_prob REAL,
  predicted_draw_prob REAL,
  predicted_away_prob REAL,
  score_home INTEGER,
  score_away INTEGER,
  similarity_cluster TEXT,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_similar_match_memory_signature ON similar_match_memory(match_signature, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_similar_match_memory_league ON similar_match_memory(league_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_similar_match_memory_fixture ON similar_match_memory(fixture_id);

CREATE TABLE IF NOT EXISTS ai_model_registry (
  id SERIAL PRIMARY KEY,
  model_version TEXT NOT NULL,
  model_type TEXT NOT NULL,
  feature_set_json JSONB NOT NULL,
  weights_json JSONB NOT NULL,
  metrics_json JSONB NOT NULL,
  training_rows INTEGER NOT NULL DEFAULT 0,
  active BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_model_registry_active ON ai_model_registry(active, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_learning_audits (
  id SERIAL PRIMARY KEY,
  audit_type TEXT NOT NULL,
  sample_size INTEGER NOT NULL DEFAULT 0,
  before_metrics_json JSONB,
  after_metrics_json JSONB,
  accepted BOOLEAN NOT NULL DEFAULT FALSE,
  recommendations_json JSONB,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_learning_audits_recent ON ai_learning_audits(created_at DESC);

CREATE TABLE IF NOT EXISTS self_improvement_queue (
  id SERIAL PRIMARY KEY,
  issue_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  description TEXT NOT NULL,
  evidence_json JSONB,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_self_improvement_queue_open ON self_improvement_queue(status, priority DESC, created_at DESC);

-- Persistent AI learning memory and two-week update records.
CREATE TABLE IF NOT EXISTS ai_learning_memory (
  id SERIAL PRIMARY KEY,
  learning_type TEXT NOT NULL,
  source TEXT NOT NULL,
  fixture_id INTEGER,
  league_id INTEGER,
  subject TEXT,
  summary TEXT NOT NULL,
  evidence_json JSONB,
  learned_weights_json JSONB,
  confidence REAL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_learning_memory_recent ON ai_learning_memory(active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_learning_memory_subject ON ai_learning_memory(subject, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_learning_memory_fixture ON ai_learning_memory(fixture_id, created_at DESC);

CREATE TABLE IF NOT EXISTS ai_biweekly_updates (
  id SERIAL PRIMARY KEY,
  period_start TIMESTAMP NOT NULL,
  period_end TIMESTAMP NOT NULL,
  status TEXT NOT NULL DEFAULT 'recorded',
  sample_size INTEGER NOT NULL DEFAULT 0,
  summary TEXT NOT NULL,
  metrics_json JSONB,
  improvements_json JSONB,
  applied_model_version TEXT,
  applied BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_biweekly_updates_period ON ai_biweekly_updates(period_start DESC, period_end DESC);
CREATE INDEX IF NOT EXISTS idx_ai_biweekly_updates_applied ON ai_biweekly_updates(applied, created_at DESC);
