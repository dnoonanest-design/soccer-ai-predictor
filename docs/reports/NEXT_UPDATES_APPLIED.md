# Step-by-step prediction platform updates applied

This package applies the next production upgrades in a staged way.

## Step 1 — Historical prediction database
Added database tables and API support for:
- `prediction_snapshots`: every model update over time
- `match_predictions`: latest pre-match/live prediction for calibration
- `match_outcomes`: final scores and results

Migration file:
- `db/001_prediction_platform.sql`

## Step 2 — Prediction history logging
The `/api/matches/:match_id/stats` endpoint now records a prediction snapshot whenever enhanced stats are calculated. This gives you the time-series data needed for accuracy learning.

New endpoint:
- `GET /api/matches/:match_id/prediction-history`

## Step 3 — Live momentum alert stream
Added a server-sent events stream for live alert updates.

New endpoints:
- `GET /api/live/alerts`
- `GET /api/live/stream`
- `POST /api/live/alerts`

This is lighter and more Replit-friendly than WebSockets, but it gives the browser instant live update behaviour.

## Step 4 — Betting tracker
Added a tracker for value bets and ROI.

New endpoints:
- `GET /api/tracker`
- `POST /api/tracker`
- `POST /api/tracker/:id/settle`

## Step 5 — AI training pipeline scaffold
Added a model-training pipeline that uses stored historical predictions/outcomes to calculate accuracy and Brier score, and records a training run. This is designed so XGBoost/LightGBM can be added once enough historical rows exist.

New endpoints:
- `GET /api/training`
- `POST /api/training/run`

## Step 6 — Performance dashboard
Added a new frontend page:
- `/performance`

It shows:
- prediction count
- pick accuracy
- Brier score
- tracker ROI
- training runs
- recent prediction results

## Step 7 — User/watchlist database foundation
Added schema tables for:
- `app_users`
- `user_watchlist`

This prepares the app for accounts, favourite matches and personalised alerts.

## Required next action in Replit
Run the SQL in `db/001_prediction_platform.sql` against your Postgres database, then restart the Repl.

## Important note
This update adds the platform structure and learning loop. It does not magically create profitable betting predictions. Accuracy improves only after the app stores enough historical predictions and final outcomes.
