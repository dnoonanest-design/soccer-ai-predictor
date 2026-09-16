-- Enforce the prediction/outcome time boundary in PostgreSQL itself. Application
-- checks remain useful, but a future route or worker must not be able to insert a
-- row labelled "prematch" once kickoff has arrived.

CREATE OR REPLACE FUNCTION reject_late_prematch_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.phase = 'prematch'
     AND (NEW.kickoff_at IS NULL OR NEW.captured_at >= NEW.kickoff_at) THEN
    RAISE EXCEPTION 'prematch audit must be captured before kickoff';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_reject_late_prematch_audit
  ON prediction_audit_records;

CREATE TRIGGER trg_reject_late_prematch_audit
BEFORE INSERT ON prediction_audit_records
FOR EACH ROW EXECUTE FUNCTION reject_late_prematch_audit();
