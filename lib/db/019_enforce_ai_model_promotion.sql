-- Enforce the adaptive-model promotion policy at the database boundary.
-- Application code already validates challengers, but a future code path or
-- manual write must not be able to activate an under-evidenced model.

CREATE OR REPLACE FUNCTION enforce_ai_model_promotion_policy()
RETURNS TRIGGER AS $$
DECLARE
  sample_size INTEGER;
  holdout_rows INTEGER;
  before_brier DOUBLE PRECISION;
  after_brier DOUBLE PRECISION;
  before_log_loss DOUBLE PRECISION;
  after_log_loss DOUBLE PRECISION;
  before_accuracy DOUBLE PRECISION;
  after_accuracy DOUBLE PRECISION;
BEGIN
  IF NEW.active IS NOT TRUE THEN
    RETURN NEW;
  END IF;

  IF NEW.model_type <> 'adaptive-chronological-calibrator' THEN
    RAISE EXCEPTION 'Only a validated adaptive chronological calibrator may be active';
  END IF;

  sample_size := GREATEST(
    COALESCE(NEW.training_rows, 0),
    CASE
      WHEN COALESCE(NEW.weights_json ->> 'sampleSize', '') ~ '^[0-9]+$'
        THEN (NEW.weights_json ->> 'sampleSize')::INTEGER
      ELSE 0
    END
  );
  holdout_rows := CASE
    WHEN COALESCE(NEW.metrics_json ->> 'holdoutRows', '') ~ '^[0-9]+$'
      THEN (NEW.metrics_json ->> 'holdoutRows')::INTEGER
    ELSE 0
  END;

  before_brier := NULLIF(NEW.metrics_json ->> 'beforeBrier', '')::DOUBLE PRECISION;
  after_brier := NULLIF(NEW.metrics_json ->> 'holdoutBrier', '')::DOUBLE PRECISION;
  before_log_loss := NULLIF(NEW.metrics_json ->> 'beforeLogLoss', '')::DOUBLE PRECISION;
  after_log_loss := NULLIF(NEW.metrics_json ->> 'holdoutLogLoss', '')::DOUBLE PRECISION;
  before_accuracy := NULLIF(NEW.metrics_json ->> 'beforeAccuracy', '')::DOUBLE PRECISION;
  after_accuracy := NULLIF(NEW.metrics_json ->> 'holdoutAccuracy', '')::DOUBLE PRECISION;

  IF sample_size < 500 THEN
    RAISE EXCEPTION 'Adaptive model promotion requires at least 500 settled matches';
  END IF;
  IF holdout_rows < 100 OR COALESCE((NEW.metrics_json ->> 'chronologicalHoldout')::BOOLEAN, FALSE) IS NOT TRUE THEN
    RAISE EXCEPTION 'Adaptive model promotion requires at least 100 chronological holdout matches';
  END IF;
  IF before_brier IS NULL OR after_brier IS NULL OR before_brier - after_brier < 0.002 THEN
    RAISE EXCEPTION 'Adaptive model promotion requires Brier improvement of at least 0.002';
  END IF;
  IF before_log_loss IS NULL OR after_log_loss IS NULL OR before_log_loss - after_log_loss < 0.001 THEN
    RAISE EXCEPTION 'Adaptive model promotion requires log-loss improvement of at least 0.001';
  END IF;
  IF before_accuracy IS NULL OR after_accuracy IS NULL OR after_accuracy < before_accuracy - 0.01 THEN
    RAISE EXCEPTION 'Adaptive model promotion exceeds the maximum accuracy regression';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enforce_ai_model_promotion_policy ON ai_model_registry;
CREATE TRIGGER trg_enforce_ai_model_promotion_policy
BEFORE INSERT OR UPDATE OF active, model_type, training_rows, weights_json, metrics_json
ON ai_model_registry
FOR EACH ROW
EXECUTE FUNCTION enforce_ai_model_promotion_policy();

-- Re-apply the sample floor before the trigger takes ownership of future writes.
UPDATE ai_model_registry
   SET active = FALSE
 WHERE active = TRUE
   AND (
     model_type <> 'adaptive-chronological-calibrator'
     OR GREATEST(
       COALESCE(training_rows, 0),
       CASE
         WHEN COALESCE(weights_json ->> 'sampleSize', '') ~ '^[0-9]+$'
           THEN (weights_json ->> 'sampleSize')::INTEGER
         ELSE 0
       END
     ) < 500
   );
