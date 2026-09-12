-- Permit the v3 audit seal. V3 signs settlement fields only after PostgreSQL
-- has normalised their stored representation, eliminating false failures.

CREATE OR REPLACE FUNCTION protect_prediction_audit_record()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'prediction audit records are append-only and cannot be deleted';
  END IF;

  IF OLD.audit_signature IS NULL
     AND OLD.signature_version IS NULL
     AND OLD.sealed_at IS NULL
     AND NEW.audit_signature IS NOT NULL
     AND NEW.signature_version IN ('hmac-sha256-v2', 'hmac-sha256-v3')
     AND NEW.sealed_at IS NOT NULL
     AND ROW(
       NEW.fixture_id, NEW.league_id, NEW.home_team, NEW.away_team, NEW.kickoff_at,
       NEW.phase, NEW.checkpoint, NEW.minute, NEW.data_tier, NEW.model_version,
       NEW.engine_revision, NEW.home_win_prob, NEW.draw_prob, NEW.away_win_prob,
       NEW.over25_prob, NEW.btts_prob, NEW.home_xg, NEW.away_xg, NEW.confidence,
       NEW.pick_confidence, NEW.confidence_band, NEW.predicted_outcome,
       NEW.circumstance_score_home, NEW.circumstance_score_away,
       NEW.home_form_score, NEW.away_form_score, NEW.captured_at
     ) IS NOT DISTINCT FROM ROW(
       OLD.fixture_id, OLD.league_id, OLD.home_team, OLD.away_team, OLD.kickoff_at,
       OLD.phase, OLD.checkpoint, OLD.minute, OLD.data_tier, OLD.model_version,
       OLD.engine_revision, OLD.home_win_prob, OLD.draw_prob, OLD.away_win_prob,
       OLD.over25_prob, OLD.btts_prob, OLD.home_xg, OLD.away_xg, OLD.confidence,
       OLD.pick_confidence, OLD.confidence_band, OLD.predicted_outcome,
       OLD.circumstance_score_home, OLD.circumstance_score_away,
       OLD.home_form_score, OLD.away_form_score, OLD.captured_at
     ) THEN
    RETURN NEW;
  END IF;

  IF ROW(
    NEW.fixture_id, NEW.league_id, NEW.home_team, NEW.away_team, NEW.kickoff_at,
    NEW.phase, NEW.checkpoint, NEW.minute, NEW.data_tier, NEW.model_version,
    NEW.engine_revision, NEW.home_win_prob, NEW.draw_prob, NEW.away_win_prob,
    NEW.over25_prob, NEW.btts_prob, NEW.home_xg, NEW.away_xg, NEW.confidence,
    NEW.pick_confidence, NEW.confidence_band, NEW.predicted_outcome,
    NEW.circumstance_score_home, NEW.circumstance_score_away,
    NEW.home_form_score, NEW.away_form_score, NEW.captured_at,
    NEW.audit_signature, NEW.signature_version, NEW.sealed_at
  ) IS DISTINCT FROM ROW(
    OLD.fixture_id, OLD.league_id, OLD.home_team, OLD.away_team, OLD.kickoff_at,
    OLD.phase, OLD.checkpoint, OLD.minute, OLD.data_tier, OLD.model_version,
    OLD.engine_revision, OLD.home_win_prob, OLD.draw_prob, OLD.away_win_prob,
    OLD.over25_prob, OLD.btts_prob, OLD.home_xg, OLD.away_xg, OLD.confidence,
    OLD.pick_confidence, OLD.confidence_band, OLD.predicted_outcome,
    OLD.circumstance_score_home, OLD.circumstance_score_away,
    OLD.home_form_score, OLD.away_form_score, OLD.captured_at,
    OLD.audit_signature, OLD.signature_version, OLD.sealed_at
  ) THEN
    RAISE EXCEPTION 'sealed prediction fields cannot be changed';
  END IF;

  IF OLD.settled_at IS NOT NULL AND ROW(
    NEW.actual_outcome, NEW.score_home, NEW.score_away, NEW.correct,
    NEW.brier_score, NEW.log_loss, NEW.over25_actual, NEW.btts_actual,
    NEW.over25_correct, NEW.btts_correct, NEW.settled_at,
    NEW.settlement_signature, NEW.outcome_recorded_at
  ) IS DISTINCT FROM ROW(
    OLD.actual_outcome, OLD.score_home, OLD.score_away, OLD.correct,
    OLD.brier_score, OLD.log_loss, OLD.over25_actual, OLD.btts_actual,
    OLD.over25_correct, OLD.btts_correct, OLD.settled_at,
    OLD.settlement_signature, OLD.outcome_recorded_at
  ) THEN
    RAISE EXCEPTION 'settled audit results cannot be changed';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
