-- Goal markets (over 2.5, both teams to score) get their own champion, so a
-- model with better goal numbers can serve them without replacing the 1X2
-- prediction. 'legacy' = the original formula's goal numbers.
ALTER TABLE model_serving_state
  ADD COLUMN IF NOT EXISTS goal_champion TEXT NOT NULL DEFAULT 'legacy',
  ADD COLUMN IF NOT EXISTS goal_champion_since TIMESTAMP;
