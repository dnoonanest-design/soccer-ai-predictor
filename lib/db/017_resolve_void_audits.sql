ALTER TABLE prediction_audit_records
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS void_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_prediction_audit_unresolved
  ON prediction_audit_records (fixture_id, kickoff_at)
  WHERE settled_at IS NULL AND voided_at IS NULL;
