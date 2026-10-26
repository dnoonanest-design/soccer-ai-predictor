-- Bookmaker odds from API-Football: match result (1X2), over/under 2.5 goals
-- and both teams to score, before kickoff and in play.
--
-- The Odds API (market_odds_snapshots) covers about 40% of the app's
-- fixtures and only the 1X2 market on the current plan. API-Football's odds
-- cover far more leagues and the goal markets, and come out of the existing
-- API-Football allowance. Rows are kept separately until tests show they make
-- predictions more accurate.
--
-- provider_updated_at is API-Football's own "update" time for the odds. For a
-- pre-match row it must be before kickoff, which also allows backfilling the
-- final pre-match odds of recently finished matches (the provider keeps them
-- for about a week). In-play rows cannot be written once the result is known.

CREATE TABLE IF NOT EXISTS apif_odds_snapshots (
  id BIGSERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  kickoff_at TIMESTAMPTZ,
  phase TEXT NOT NULL CHECK (phase IN ('prematch', 'live')),
  source TEXT NOT NULL CHECK (source IN ('sampler', 'backfill', 'live')),
  bookmaker_id INTEGER NOT NULL,
  bookmaker_name TEXT,
  minute INTEGER,
  score_home INTEGER,
  score_away INTEGER,
  home_odds REAL,
  draw_odds REAL,
  away_odds REAL,
  over25_odds REAL,
  under25_odds REAL,
  btts_yes_odds REAL,
  btts_no_odds REAL,
  provider_updated_at TIMESTAMPTZ NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT uniq_apif_odds UNIQUE (fixture_id, bookmaker_id, phase, provider_updated_at)
);

CREATE INDEX IF NOT EXISTS idx_apif_odds_fixture ON apif_odds_snapshots (fixture_id, phase, provider_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_apif_odds_kickoff ON apif_odds_snapshots (kickoff_at) WHERE phase = 'prematch';

CREATE OR REPLACE FUNCTION protect_apif_odds_snapshot()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'API-Football odds snapshots are append-only';
  END IF;
  IF NEW.phase = 'prematch' AND (NEW.kickoff_at IS NULL OR NEW.provider_updated_at >= NEW.kickoff_at) THEN
    RAISE EXCEPTION 'pre-match odds must have been updated before kickoff';
  END IF;
  IF NEW.phase = 'live' AND EXISTS (SELECT 1 FROM match_outcomes o WHERE o.fixture_id = NEW.fixture_id) THEN
    RAISE EXCEPTION 'in-play odds must be stored before the result is known';
  END IF;
  NEW.observed_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_protect_apif_odds_snapshot ON apif_odds_snapshots;
CREATE TRIGGER trg_protect_apif_odds_snapshot
  BEFORE INSERT OR UPDATE OR DELETE ON apif_odds_snapshots
  FOR EACH ROW EXECUTE FUNCTION protect_apif_odds_snapshot();
