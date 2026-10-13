-- Upgrades after the 13 October recheck.
--
-- 1. Goal markets in the challenger gate: each challenger row also stores the
--    challenger's and the champion's over 2.5 and BTTS probabilities, scored
--    after full time, so a promotion cannot make goal markets worse unseen.
-- 2. Per-fixture shot statistics for the shots-aware challenger (step 7).
-- 3. In-play challenger with fitted multipliers, judged on live checkpoints.

ALTER TABLE model_challenger_predictions
  ADD COLUMN IF NOT EXISTS over25_prob REAL,
  ADD COLUMN IF NOT EXISTS btts_prob REAL,
  ADD COLUMN IF NOT EXISTS champion_over25_prob REAL,
  ADD COLUMN IF NOT EXISTS champion_btts_prob REAL,
  ADD COLUMN IF NOT EXISTS over25_actual BOOLEAN,
  ADD COLUMN IF NOT EXISTS btts_actual BOOLEAN,
  ADD COLUMN IF NOT EXISTS over25_log_loss REAL,
  ADD COLUMN IF NOT EXISTS champion_over25_log_loss REAL,
  ADD COLUMN IF NOT EXISTS btts_log_loss REAL,
  ADD COLUMN IF NOT EXISTS champion_btts_log_loss REAL;

-- Goal-market forecasts are frozen with the 1X2 forecast.
CREATE OR REPLACE FUNCTION reject_late_challenger_prediction()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND clock_timestamp() >= NEW.kickoff_at THEN
    RAISE EXCEPTION 'challenger predictions must be stored before kickoff';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.fixture_id, NEW.challenger, NEW.checkpoint, NEW.kickoff_at, NEW.captured_at,
    NEW.home_win_prob, NEW.draw_prob, NEW.away_win_prob,
    NEW.champion_home_prob, NEW.champion_draw_prob, NEW.champion_away_prob,
    NEW.over25_prob, NEW.btts_prob, NEW.champion_over25_prob, NEW.champion_btts_prob
  ) IS DISTINCT FROM ROW(
    OLD.fixture_id, OLD.challenger, OLD.checkpoint, OLD.kickoff_at, OLD.captured_at,
    OLD.home_win_prob, OLD.draw_prob, OLD.away_win_prob,
    OLD.champion_home_prob, OLD.champion_draw_prob, OLD.champion_away_prob,
    OLD.over25_prob, OLD.btts_prob, OLD.champion_over25_prob, OLD.champion_btts_prob
  ) THEN
    RAISE EXCEPTION 'challenger forecasts are frozen once stored';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS fixture_team_stats (
  fixture_id INTEGER PRIMARY KEY,
  league_id INTEGER NOT NULL,
  season INTEGER NOT NULL,
  kickoff_at TIMESTAMP NOT NULL,
  home_team_id INTEGER NOT NULL,
  away_team_id INTEGER NOT NULL,
  home_goals INTEGER NOT NULL,
  away_goals INTEGER NOT NULL,
  -- NULL when the provider has no statistics for this fixture.
  home_shots INTEGER,
  away_shots INTEGER,
  home_shots_on_target INTEGER,
  away_shots_on_target INTEGER,
  home_corners INTEGER,
  away_corners INTEGER,
  home_xg REAL,
  away_xg REAL,
  fetched_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_fixture_team_stats_league ON fixture_team_stats (league_id, kickoff_at);

CREATE TABLE IF NOT EXISTS model_inplay_predictions (
  id BIGSERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  challenger TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  minute INTEGER NOT NULL,
  captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
  home_win_prob REAL NOT NULL,
  draw_prob REAL NOT NULL,
  away_win_prob REAL NOT NULL,
  champion_home_prob REAL NOT NULL,
  champion_draw_prob REAL NOT NULL,
  champion_away_prob REAL NOT NULL,
  params JSONB,
  actual_outcome TEXT,
  brier_score REAL,
  champion_brier_score REAL,
  log_loss REAL,
  champion_log_loss REAL,
  settled_at TIMESTAMP,
  CONSTRAINT uniq_inplay_fixture_checkpoint UNIQUE (fixture_id, challenger, checkpoint),
  CONSTRAINT inplay_probabilities_unit CHECK (
    home_win_prob BETWEEN 0 AND 1 AND draw_prob BETWEEN 0 AND 1 AND away_win_prob BETWEEN 0 AND 1
  )
);
CREATE INDEX IF NOT EXISTS idx_inplay_unsettled ON model_inplay_predictions (fixture_id) WHERE settled_at IS NULL;

-- In-play forecasts are frozen once stored, and cannot be stored for a
-- fixture whose result is already recorded.
CREATE OR REPLACE FUNCTION protect_inplay_prediction()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND EXISTS (SELECT 1 FROM match_outcomes o WHERE o.fixture_id = NEW.fixture_id) THEN
    RAISE EXCEPTION 'in-play predictions must be stored before the result is known';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.fixture_id, NEW.challenger, NEW.checkpoint, NEW.minute, NEW.captured_at,
    NEW.home_win_prob, NEW.draw_prob, NEW.away_win_prob,
    NEW.champion_home_prob, NEW.champion_draw_prob, NEW.champion_away_prob
  ) IS DISTINCT FROM ROW(
    OLD.fixture_id, OLD.challenger, OLD.checkpoint, OLD.minute, OLD.captured_at,
    OLD.home_win_prob, OLD.draw_prob, OLD.away_win_prob,
    OLD.champion_home_prob, OLD.champion_draw_prob, OLD.champion_away_prob
  ) THEN
    RAISE EXCEPTION 'in-play challenger forecasts are frozen once stored';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_inplay_prediction ON model_inplay_predictions;
CREATE TRIGGER trg_protect_inplay_prediction
  BEFORE INSERT OR UPDATE ON model_inplay_predictions
  FOR EACH ROW EXECUTE FUNCTION protect_inplay_prediction();

ALTER TABLE model_serving_state
  ADD COLUMN IF NOT EXISTS inplay_champion TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS inplay_params JSONB,
  ADD COLUMN IF NOT EXISTS inplay_updated_at TIMESTAMP;
