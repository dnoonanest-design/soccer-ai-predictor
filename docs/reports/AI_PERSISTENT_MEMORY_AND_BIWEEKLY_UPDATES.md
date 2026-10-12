# AI Persistent Memory + Two-Week Improvement Updates

This version adds a permanent learning layer for the soccer predictor.

## What it now remembers

The app stores long-term AI learning in Postgres, including:

- raw live/deep match stats
- settled results
- prediction snapshots
- similar-match memories
- circumstance learning: formations, team selection, injuries, cards, star-player performance and form
- AI learning audits
- self-improvement signals
- fortnightly AI update records

New tables:

- `ai_learning_memory`
- `ai_biweekly_updates`

## Two-week update cycle

A background job runs every two weeks by default:

```env
BACKGROUND_BIWEEKLY_UPDATE_MS=1209600000
```

The job:

1. refreshes similar-match memory
2. recalculates circumstance influence
3. checks accuracy and Brier score
4. consolidates learning into permanent memory
5. creates a two-week AI update record
6. safely applies calibration/model data only when enough evidence exists

## Safety rule

The app does **not** rewrite its own source code automatically. Instead, it improves prediction behaviour by updating database-backed model weights, calibration settings and learning memory. This is safer for production and avoids breaking the app.

## New endpoints

- `GET /api/ai/memory` — view stored AI learning and recent two-week updates
- `POST /api/ai/generate-biweekly-update` — manually generate the two-week update
- `POST /api/ai/generate-biweekly-update?force=true` — force a new update even if one already exists for the period

## Required setup

Run the updated SQL migration before deploying:

```bash
psql "$DATABASE_URL" -f db/001_prediction_platform.sql
```

Keep the backend hosted on an always-on server if you want learning to continue while the iPad app is closed.
