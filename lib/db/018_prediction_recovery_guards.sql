-- Separate result settlement from optional player-stat enrichment. The queue
-- survives restarts and enforces bounded exponential retry scheduling.
CREATE TABLE IF NOT EXISTS player_stats_recovery_queue (
  fixture_id INTEGER PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_retry_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_player_stats_recovery_due
  ON player_stats_recovery_queue (next_retry_at, fixture_id)
  WHERE completed_at IS NULL;

-- Provider result corrections are not prediction tampering. Preserve the old
-- signed settlement, quarantine it from metrics/learning, and allow other
-- independently sealed checkpoints for the fixture to remain usable.
UPDATE prediction_audit_records a
   SET voided_at = COALESCE(a.voided_at, NOW()),
       void_reason = COALESCE(a.void_reason, 'provider-result-correction')
  FROM match_outcomes o
 WHERE o.fixture_id = a.fixture_id
   AND a.settled_at IS NOT NULL
   AND a.voided_at IS NULL
   AND ROW(a.actual_outcome, a.score_home, a.score_away)
       IS DISTINCT FROM ROW(o.outcome, o.score_home, o.score_away);

-- A calibrator promoted under the former 250-match policy must not remain
-- labelled active after the promotion floor is raised to 500.
UPDATE ai_model_registry
   SET active = FALSE
 WHERE active = TRUE
   AND model_type = 'adaptive-chronological-calibrator'
   AND GREATEST(
         COALESCE(training_rows, 0),
         CASE
           WHEN COALESCE(weights_json ->> 'sampleSize', '') ~ '^[0-9]+$'
             THEN (weights_json ->> 'sampleSize')::INTEGER
           ELSE 0
         END
       ) < 500;
