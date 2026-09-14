-- A failed lifecycle verdict is terminal: the service only emits "failed" after
-- the applicable grace window (or after a completed lifecycle fails its checks).
-- Preserve the failure and all evidence, but stop terminal failures occupying
-- the active reliability queue forever.

UPDATE lifecycle_reliability_fixtures
   SET completed_at = COALESCE(completed_at, last_evaluated_at, NOW()),
       updated_at = NOW()
 WHERE verdict = 'failed'
   AND completed_at IS NULL;

CREATE OR REPLACE FUNCTION archive_terminal_lifecycle_failure()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.verdict = 'failed' AND NEW.completed_at IS NULL THEN
    NEW.completed_at := COALESCE(NEW.last_evaluated_at, NOW());
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_archive_terminal_lifecycle_failure
  ON lifecycle_reliability_fixtures;

CREATE TRIGGER trg_archive_terminal_lifecycle_failure
BEFORE INSERT OR UPDATE ON lifecycle_reliability_fixtures
FOR EACH ROW
EXECUTE FUNCTION archive_terminal_lifecycle_failure();
