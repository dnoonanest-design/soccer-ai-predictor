-- Safety guard for the lifecycle reliability cohort.
-- The first release intentionally over-fetched candidates; keep the monitored
-- cohort bounded and future-facing at the database boundary as well.

CREATE TABLE IF NOT EXISTS lifecycle_reliability_migration_flags (
  flag TEXT PRIMARY KEY,
  applied_at TIMESTAMP NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM lifecycle_reliability_migration_flags
    WHERE flag = 'reset_initial_debug_cohort_v1'
  ) THEN
    DELETE FROM lifecycle_reliability_runs;
    DELETE FROM lifecycle_reliability_fixtures;
    INSERT INTO lifecycle_reliability_migration_flags(flag)
    VALUES ('reset_initial_debug_cohort_v1');
  END IF;
END $$;

CREATE OR REPLACE FUNCTION enforce_lifecycle_reliability_enrolment()
RETURNS TRIGGER AS $$
DECLARE
  active_count INTEGER;
BEGIN
  -- Reliability testing is forward-looking: do not enrol matches that have
  -- already kicked off before the test starts tracking them.
  IF NEW.kickoff_at <= NOW() THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*)::int
    INTO active_count
    FROM lifecycle_reliability_fixtures
   WHERE completed_at IS NULL;

  -- Default application cohort is 12. Keep this hard safety ceiling so a bad
  -- discovery query cannot create an unbounded monitoring backlog.
  IF active_count >= 12 THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_lifecycle_reliability_enrolment_guard
  ON lifecycle_reliability_fixtures;

CREATE TRIGGER trg_lifecycle_reliability_enrolment_guard
BEFORE INSERT ON lifecycle_reliability_fixtures
FOR EACH ROW EXECUTE FUNCTION enforce_lifecycle_reliability_enrolment();
