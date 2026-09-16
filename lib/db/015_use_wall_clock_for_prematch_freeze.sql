-- NOW() is fixed at transaction start in PostgreSQL. Use the actual wall clock
-- so a transaction opened before kickoff cannot mutate the prediction after
-- kickoff while retaining its earlier transaction timestamp.

CREATE OR REPLACE FUNCTION freeze_started_prematch_prediction()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_live = FALSE THEN
    RAISE EXCEPTION 'prematch predictions cannot be deleted';
  END IF;

  IF OLD.is_live = FALSE
     AND (OLD.kickoff_at IS NULL OR clock_timestamp() >= OLD.kickoff_at) THEN
    RAISE EXCEPTION 'prematch prediction is frozen at kickoff';
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.is_live <> OLD.is_live THEN
    RAISE EXCEPTION 'prediction phase cannot be changed';
  END IF;

  IF TG_OP = 'UPDATE' AND OLD.is_live = FALSE AND ROW(
    NEW.fixture_id, NEW.home_team, NEW.away_team, NEW.league_id, NEW.kickoff_at
  ) IS DISTINCT FROM ROW(
    OLD.fixture_id, OLD.home_team, OLD.away_team, OLD.league_id, OLD.kickoff_at
  ) THEN
    RAISE EXCEPTION 'prematch prediction identity and kickoff are immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION reject_started_prematch_prediction_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_live = FALSE
     AND (NEW.kickoff_at IS NULL OR clock_timestamp() >= NEW.kickoff_at) THEN
    RAISE EXCEPTION 'prematch prediction must be stored before kickoff';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
