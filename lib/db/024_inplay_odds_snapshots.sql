-- Bookmaker prices during play, with the minute and score they were quoted at.
--
-- The app already downloads live odds about every 40 seconds for leagues with
-- a match in progress (to show them), but market_odds_snapshots stops at
-- kickoff. Keeping these prices costs no extra Odds API credits and lets the
-- live model be tested against the in-play market before any of it is used.
--
-- Kept apart from market_odds_snapshots so pre-match opening/closing analysis
-- is unaffected. Rows are append-only and cannot be written once the result
-- is recorded.

CREATE TABLE IF NOT EXISTS inplay_odds_snapshots (
  id BIGSERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  minute INTEGER,
  score_home INTEGER,
  score_away INTEGER,
  bookmaker_key TEXT NOT NULL,
  home_odds REAL NOT NULL,
  draw_odds REAL NOT NULL,
  away_odds REAL NOT NULL,
  -- No-vig percentages (0-100), same scale as market_odds_snapshots.
  implied_home_prob REAL NOT NULL,
  implied_draw_prob REAL NOT NULL,
  implied_away_prob REAL NOT NULL,
  -- The bookmaker's own last_update for this market; old values mean a stale or suspended price.
  bookmaker_updated_at TIMESTAMPTZ,
  capture_bucket TEXT NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uniq_inplay_odds_bucket UNIQUE (fixture_id, bookmaker_key, capture_bucket)
);

CREATE INDEX IF NOT EXISTS idx_inplay_odds_fixture_time
  ON inplay_odds_snapshots (fixture_id, observed_at);

CREATE OR REPLACE FUNCTION protect_inplay_odds_snapshot()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF EXISTS (SELECT 1 FROM match_outcomes o WHERE o.fixture_id = NEW.fixture_id) THEN
      RAISE EXCEPTION 'in-play odds must be stored before the result is known';
    END IF;
    NEW.observed_at := clock_timestamp();
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'in-play odds snapshots are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_inplay_odds_snapshot ON inplay_odds_snapshots;
CREATE TRIGGER trg_protect_inplay_odds_snapshot
  BEFORE INSERT OR UPDATE OR DELETE ON inplay_odds_snapshots
  FOR EACH ROW EXECUTE FUNCTION protect_inplay_odds_snapshot();
