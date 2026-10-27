-- /api/xg reads the latest live/pre-match reading per fixture from the last
-- 10 days; without this index it scanned every snapshot ever stored.
CREATE INDEX IF NOT EXISTS idx_prediction_snapshots_created ON prediction_snapshots (created_at);
