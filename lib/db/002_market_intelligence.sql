CREATE TABLE IF NOT EXISTS market_odds_snapshots (
  id SERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  kickoff_at TIMESTAMP,
  match_status TEXT NOT NULL,
  bookmaker_key TEXT NOT NULL,
  bookmaker_name TEXT,
  home_odds REAL NOT NULL,
  draw_odds REAL NOT NULL,
  away_odds REAL NOT NULL,
  implied_home_prob REAL NOT NULL,
  implied_draw_prob REAL NOT NULL,
  implied_away_prob REAL NOT NULL,
  capture_bucket TEXT NOT NULL,
  observed_at TIMESTAMP NOT NULL DEFAULT NOW(),
  CONSTRAINT uniq_market_fixture_book_bucket
    UNIQUE (fixture_id, bookmaker_key, capture_bucket)
);

CREATE INDEX IF NOT EXISTS idx_market_odds_fixture_time
  ON market_odds_snapshots (fixture_id, observed_at);

CREATE INDEX IF NOT EXISTS idx_market_odds_bookmaker_time
  ON market_odds_snapshots (bookmaker_key, observed_at);
