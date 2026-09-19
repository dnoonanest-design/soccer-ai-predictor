-- Historical similar-match registry rows predate chronological holdout
-- promotion. They are diagnostics, not serving models, and must never be
-- labelled active. The guarded adaptive learner is the only component allowed
-- to activate an adaptive-chronological-calibrator after validation.

UPDATE ai_model_registry
SET active = FALSE
WHERE active = TRUE
  AND model_type <> 'adaptive-chronological-calibrator';
