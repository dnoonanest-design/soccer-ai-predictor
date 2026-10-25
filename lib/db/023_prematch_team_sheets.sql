-- Who was in and who was out, as known before kickoff.
--
-- match_circumstance_snapshots (022) records only counts ("3 missing"), and the
-- full lineup and injury lists in match_circumstances are overwritten once the
-- match starts. Learning what a missing player is worth needs the names and
-- ids, captured before kickoff and never changed afterwards.
--
-- One row per fixture side each time the published sheet changes (injury list
-- updated, starting XI announced). Rows are append-only and must be written
-- before kickoff by the wall clock.

CREATE TABLE IF NOT EXISTS prematch_team_sheets (
  id BIGSERIAL PRIMARY KEY,
  fixture_id INTEGER NOT NULL,
  league_id INTEGER,
  team_id INTEGER NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('home', 'away')),
  kickoff_at TIMESTAMPTZ NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  formation TEXT,
  -- [{"id":..,"name":..,"pos":..}]; NULL until the provider publishes the XI.
  starting_xi JSONB,
  bench JSONB,
  -- [{"id":..,"name":..,"type":"Missing Fixture"|"Questionable",..,"reason":..}]
  missing JSONB NOT NULL DEFAULT '[]'::jsonb,
  content_hash TEXT NOT NULL,
  CONSTRAINT uniq_prematch_team_sheet UNIQUE (fixture_id, side, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_prematch_team_sheets_fixture
  ON prematch_team_sheets (fixture_id, side, captured_at DESC);
CREATE INDEX IF NOT EXISTS idx_prematch_team_sheets_team
  ON prematch_team_sheets (team_id, kickoff_at DESC);

CREATE OR REPLACE FUNCTION reject_late_prematch_team_sheet()
RETURNS TRIGGER AS $$
BEGIN
  IF clock_timestamp() >= NEW.kickoff_at THEN
    RAISE EXCEPTION 'prematch team sheet must be stored before kickoff';
  END IF;
  NEW.captured_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION protect_prematch_team_sheet()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'prematch team sheets are append-only';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_late_prematch_team_sheet ON prematch_team_sheets;
CREATE TRIGGER trg_reject_late_prematch_team_sheet
  BEFORE INSERT ON prematch_team_sheets
  FOR EACH ROW EXECUTE FUNCTION reject_late_prematch_team_sheet();

DROP TRIGGER IF EXISTS trg_protect_prematch_team_sheet ON prematch_team_sheets;
CREATE TRIGGER trg_protect_prematch_team_sheet
  BEFORE UPDATE OR DELETE ON prematch_team_sheets
  FOR EACH ROW EXECUTE FUNCTION protect_prematch_team_sheet();
