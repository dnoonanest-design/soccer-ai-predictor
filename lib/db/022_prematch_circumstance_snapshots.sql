-- match_circumstances keeps one row per fixture and is overwritten every
-- minute during play, so the pre-kickoff lineup, injury and form evidence was
-- lost by the time a match settled. Reports and learning that ask "what was
-- known before kickoff" (updated_at <= captured_at) almost never found a row.
-- Pre-kickoff collections are now also appended here and never overwritten.

CREATE TABLE IF NOT EXISTS match_circumstance_snapshots (
  id BIGSERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  status TEXT NOT NULL,
  home_starting_xi_count INTEGER,
  away_starting_xi_count INTEGER,
  home_missing_players INTEGER,
  away_missing_players INTEGER,
  home_red_cards INTEGER,
  away_red_cards INTEGER,
  home_star_player_rating REAL,
  away_star_player_rating REAL,
  home_form_score REAL,
  away_form_score REAL,
  circumstance_score_home REAL,
  circumstance_score_away REAL,
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_circumstance_snapshots_fixture
  ON match_circumstance_snapshots (fixture_id, updated_at DESC);

-- Everything known before kickoff: the append-only snapshots, plus the live
-- table's row while it is still pre-kickoff (older fixtures).
CREATE OR REPLACE VIEW prematch_circumstances AS
  SELECT fixture_id, status, updated_at,
         home_starting_xi_count, away_starting_xi_count,
         home_missing_players, away_missing_players,
         home_red_cards, away_red_cards,
         home_star_player_rating, away_star_player_rating,
         home_form_score, away_form_score,
         circumstance_score_home, circumstance_score_away
    FROM match_circumstance_snapshots
  UNION ALL
  SELECT fixture_id, status, updated_at,
         home_starting_xi_count, away_starting_xi_count,
         home_missing_players, away_missing_players,
         home_red_cards, away_red_cards,
         home_star_player_rating::real, away_star_player_rating::real,
         home_form_score::real, away_form_score::real,
         circumstance_score_home::real, circumstance_score_away::real
    FROM match_circumstances
   WHERE status = 'upcoming';
