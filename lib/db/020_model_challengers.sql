-- Champion/challenger model evaluation (analysis plan steps 2-7).
--
-- Every pre-match capture records each challenger's forecast beside the
-- champion's forecast for the same fixture and checkpoint. Rows are written
-- before kickoff only and settled after full time, so challengers are judged
-- on matches they had not seen, exactly like the champion.

CREATE TABLE IF NOT EXISTS model_challenger_predictions (
  id BIGSERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  challenger TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  kickoff_at TIMESTAMP NOT NULL,
  captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
  home_win_prob REAL NOT NULL,
  draw_prob REAL NOT NULL,
  away_win_prob REAL NOT NULL,
  champion_home_prob REAL NOT NULL,
  champion_draw_prob REAL NOT NULL,
  champion_away_prob REAL NOT NULL,
  details JSONB,
  actual_outcome TEXT,
  brier_score REAL,
  champion_brier_score REAL,
  log_loss REAL,
  champion_log_loss REAL,
  settled_at TIMESTAMP,
  CONSTRAINT uniq_challenger_fixture_checkpoint UNIQUE (fixture_id, challenger, checkpoint),
  CONSTRAINT challenger_probabilities_unit CHECK (
    home_win_prob BETWEEN 0 AND 1 AND draw_prob BETWEEN 0 AND 1 AND away_win_prob BETWEEN 0 AND 1
  )
);

CREATE INDEX IF NOT EXISTS idx_challenger_unsettled
  ON model_challenger_predictions (fixture_id) WHERE settled_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_challenger_report
  ON model_challenger_predictions (challenger, settled_at, captured_at DESC);

CREATE OR REPLACE FUNCTION reject_late_challenger_prediction()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' AND clock_timestamp() >= NEW.kickoff_at THEN
    RAISE EXCEPTION 'challenger predictions must be stored before kickoff';
  END IF;
  IF TG_OP = 'UPDATE' AND ROW(
    NEW.fixture_id, NEW.challenger, NEW.checkpoint, NEW.kickoff_at, NEW.captured_at,
    NEW.home_win_prob, NEW.draw_prob, NEW.away_win_prob,
    NEW.champion_home_prob, NEW.champion_draw_prob, NEW.champion_away_prob
  ) IS DISTINCT FROM ROW(
    OLD.fixture_id, OLD.challenger, OLD.checkpoint, OLD.kickoff_at, OLD.captured_at,
    OLD.home_win_prob, OLD.draw_prob, OLD.away_win_prob,
    OLD.champion_home_prob, OLD.champion_draw_prob, OLD.champion_away_prob
  ) THEN
    RAISE EXCEPTION 'challenger forecasts are frozen once stored';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_late_challenger_prediction ON model_challenger_predictions;
CREATE TRIGGER trg_reject_late_challenger_prediction
  BEFORE INSERT OR UPDATE ON model_challenger_predictions
  FOR EACH ROW EXECUTE FUNCTION reject_late_challenger_prediction();

-- Plan step 5: the champion's probabilities before the learned base-rate blend
-- and before the data-quality shrink, stored beside each sealed audit
-- checkpoint so the calibrator trains on exactly what serving starts from.
CREATE TABLE IF NOT EXISTS prediction_raw_components (
  fixture_id INTEGER NOT NULL,
  checkpoint TEXT NOT NULL,
  model_version TEXT NOT NULL,
  engine_revision TEXT NOT NULL,
  pre_prior_home REAL NOT NULL,
  pre_prior_draw REAL NOT NULL,
  pre_prior_away REAL NOT NULL,
  prior_weight REAL NOT NULL,
  reliability REAL NOT NULL,
  captured_at TIMESTAMP NOT NULL DEFAULT NOW(),
  PRIMARY KEY (fixture_id, checkpoint, model_version, engine_revision)
);

-- Which model serves pre-match predictions. 'legacy' = the original formula.
-- Changed only by the promotion gate; every change is logged.
CREATE TABLE IF NOT EXISTS model_serving_state (
  id SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  champion TEXT NOT NULL DEFAULT 'legacy',
  calibration JSONB,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
INSERT INTO model_serving_state (id, champion) VALUES (1, 'legacy') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS model_promotion_log (
  id BIGSERIAL PRIMARY KEY,
  previous_champion TEXT NOT NULL,
  new_champion TEXT NOT NULL,
  decided_at TIMESTAMP NOT NULL DEFAULT NOW(),
  evidence JSONB NOT NULL
);
