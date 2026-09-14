-- Evidence guards for automatic learning.
-- These database-level rules are deliberately conservative: learning jobs may
-- analyse smaller samples, but they cannot promote them into serve-time adaptive
-- weights or active residual factors until enough settled evidence exists.

CREATE OR REPLACE FUNCTION guard_adaptive_training_evidence()
RETURNS TRIGGER AS $$
DECLARE
  payload JSONB;
  adaptive JSONB;
  adaptive_samples INTEGER;
BEGIN
  BEGIN
    payload := NEW.weights_json::jsonb;
  EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
  END;

  adaptive := payload -> 'adaptiveWeights';
  IF adaptive IS NULL THEN
    RETURN NEW;
  END IF;

  BEGIN
    adaptive_samples := COALESCE((adaptive ->> 'sampleSize')::integer, NEW.training_rows, 0);
  EXCEPTION WHEN OTHERS THEN
    adaptive_samples := COALESCE(NEW.training_rows, 0);
  END;

  IF adaptive_samples < 250 THEN
    NEW.weights_json := (payload - 'adaptiveWeights')::text;
    NEW.notes := CONCAT_WS(' ', NULLIF(NEW.notes, ''),
      FORMAT('[evidence-guard] Adaptive weights withheld: %s settled samples; 250 required.', adaptive_samples));
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_adaptive_training_evidence ON model_training_runs;
CREATE TRIGGER trg_guard_adaptive_training_evidence
BEFORE INSERT OR UPDATE OF weights_json, training_rows ON model_training_runs
FOR EACH ROW EXECUTE FUNCTION guard_adaptive_training_evidence();

CREATE OR REPLACE FUNCTION guard_residual_factor_evidence()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.factor_group = 'adaptive_residual' AND COALESCE(NEW.sample_size, 0) < 100 THEN
    NEW.active := FALSE;
    NEW.notes := CONCAT_WS(' ', NULLIF(NEW.notes, ''),
      FORMAT('[evidence-guard] Residual factor held inactive: %s samples; 100 required.', COALESCE(NEW.sample_size, 0)));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_residual_factor_evidence ON factor_learning_insights;
CREATE TRIGGER trg_guard_residual_factor_evidence
BEFORE INSERT OR UPDATE OF sample_size, active ON factor_learning_insights
FOR EACH ROW EXECUTE FUNCTION guard_residual_factor_evidence();

-- Do not rewrite historical model-training rows; historical audit evidence must
-- remain unchanged. Existing low-sample residual insights are safe to deactivate.
UPDATE factor_learning_insights
   SET active = FALSE,
       notes = CONCAT_WS(' ', NULLIF(notes, ''),
         FORMAT('[evidence-guard] Residual factor held inactive: %s samples; 100 required.', sample_size))
 WHERE factor_group = 'adaptive_residual'
   AND sample_size < 100
   AND active = TRUE;
