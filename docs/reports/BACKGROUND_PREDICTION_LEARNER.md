# Background Prediction Learner

This version adds backend learning that can keep collecting data while the iPad/web app is closed, as long as the server host stays running.

## What was added

- Cron-style background jobs started by the API server.
- Live deep-stat snapshots for active matches.
- Finished-result settlement.
- Automatic open bet settlement for common markets.
- Automatic recalibration/training runs.
- Background job status endpoints.
- New Postgres tables for deep stats, job logs and calibration parameters.

## Required environment variables

```env
BACKGROUND_LEARNER_ENABLED=true
BACKGROUND_LIVE_STATS_MS=60000
BACKGROUND_SETTLE_MS=600000
BACKGROUND_TRAIN_MS=21600000
BACKGROUND_MAX_LIVE_MATCHES=12
```

For best results, host the API on an always-on service. If Replit sleeps, background learning pauses until the server wakes again.

## New API endpoints

```text
GET  /api/background/status
POST /api/background/run/live
POST /api/background/run/settle
POST /api/background/run/recalibrate
```

## Database setup

Run:

```text
db/001_prediction_platform.sql
```

This creates the extra background learner tables if they do not already exist.
