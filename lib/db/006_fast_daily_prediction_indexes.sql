-- Fast read indexes for stored daily prediction output.
-- These indexes keep /api/predictions/today and other date-bounded prediction
-- reads fast as the prediction history grows. They do not alter model output.

CREATE INDEX IF NOT EXISTS idx_prediction_audit_prematch_kickoff_latest
  ON prediction_audit_records(kickoff_at, fixture_id, captured_at DESC)
  WHERE phase = 'prematch';

CREATE INDEX IF NOT EXISTS idx_match_predictions_prematch_kickoff_latest
  ON match_predictions(kickoff_at, fixture_id, updated_at DESC)
  WHERE is_live = FALSE;

ANALYZE prediction_audit_records;
ANALYZE match_predictions;
