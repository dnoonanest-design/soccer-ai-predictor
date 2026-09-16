-- The legacy match_predictions table is still used as a compatibility
-- fallback. Allow refinements before kickoff, but make the final prematch row
-- append-only in effect once the match starts so outcomes cannot rewrite it.

CREATE OR REPLACE FUNCTION freeze_started_prematch_prediction()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.is_live = FALSE THEN
    RAISE EXCEPTION 'prematch predictions cannot be deleted';
  END IF;

  IF OLD.is_live = FALSE
     AND (OLD.kickoff_at IS NULL OR NOW() >= OLD.kickoff_at) THEN
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

DROP TRIGGER IF EXISTS trg_freeze_started_prematch_prediction
  ON match_predictions;

CREATE TRIGGER trg_freeze_started_prematch_prediction
BEFORE UPDATE OR DELETE ON match_predictions
FOR EACH ROW EXECUTE FUNCTION freeze_started_prematch_prediction();

CREATE OR REPLACE FUNCTION reject_started_prematch_prediction_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.is_live = FALSE
     AND (NEW.kickoff_at IS NULL OR NEW.updated_at >= NEW.kickoff_at) THEN
    RAISE EXCEPTION 'prematch prediction must be stored before kickoff';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_started_prematch_prediction_insert
  ON match_predictions;

CREATE TRIGGER trg_reject_started_prematch_prediction_insert
BEFORE INSERT ON match_predictions
FOR EACH ROW EXECUTE FUNCTION reject_started_prematch_prediction_insert();
