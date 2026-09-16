# Railway deployment guide

This package is prepared for Railway as a single web service that serves both:

- the API backend at `/api/*`
- the built React/iPad/PWA dashboard from the same Railway URL

## 1. Create a Railway project

1. Go to Railway.
2. Create a new project.
3. Choose **Deploy from GitHub repo** if you have pushed this ZIP to GitHub, or upload/import the project into a repo first.
4. Add a Railway **PostgreSQL** database plugin.

## 2. Required Railway variables

Add these in Railway → Service → Variables:

```env
NODE_ENV=production
BASE_PATH=/
API_FOOTBALL_KEY=your_api_football_key
ODDS_API_KEY=your_odds_api_key
BACKGROUND_LEARNER_ENABLED=true
BACKGROUND_LIVE_STATS_MS=60000
BACKGROUND_SETTLE_MS=600000
BACKGROUND_TRAIN_MS=21600000
BACKGROUND_BIWEEKLY_UPDATE_MS=1209600000
BACKGROUND_MAX_LIVE_MATCHES=12
MIN_AUTO_CALIBRATION_SAMPLE=250
FUTURE_PREDICTION_BASELINE_ENABLED=true
FUTURE_PREDICTION_WARMUP_RETRY_MS=3600000
MATCH_SNAPSHOT_DAILY_TTL_MS=10000
MATCH_SNAPSHOT_WEEKLY_TTL_MS=30000
MATCH_SNAPSHOT_PREWARM_ENABLED=true
PREDICTION_AUDIT_SIGNING_KEY=generate_a_random_secret_of_at_least_32_bytes
# Optional: enables scheduled AI-written player insight summaries. It never
# creates or changes prediction probabilities.
ANTHROPIC_API_KEY=your_anthropic_key
```

Railway PostgreSQL normally provides `DATABASE_URL` automatically. If it does not, copy the PostgreSQL connection string into a variable called `DATABASE_URL`.

## 3. Database migration

Railway runs this automatically before every deployment through
`preDeployCommand`. To verify it manually in the Railway service shell, run:

```bash
pnpm run migrate
```

This applies every numbered migration in order, including:

```bash
lib/db/012_player_intelligence.sql
lib/db/013_reject_late_prematch_audits.sql
lib/db/014_freeze_prematch_predictions.sql
```

Migration 013 rejects audit captures labelled pre-match at or after kickoff.
Migration 014 freezes the compatibility `match_predictions` pre-match row at
kickoff and rejects late inserts. Production readiness verifies both the
migration records and their PostgreSQL triggers.

## 4. Build/start commands

Railway should detect `railway.toml` automatically.

Build command:

```bash
corepack enable && corepack prepare pnpm@11.19.0 --activate && pnpm install --frozen-lockfile && pnpm run railway:build
```

Start command:

```bash
pnpm run railway:start
```

Health check:

```text
/api/healthz
```

Production readiness (database migration, background learner and provider
state, audit signing key and prediction-boundary triggers):

```text
/api/health/readiness
```

## 5. iPad install

After Railway gives you a public URL:

1. Open the Railway URL in Safari on iPad.
2. Tap Share.
3. Tap **Add to Home Screen**.

## 6. Important notes

- Keep the Railway service always on so the background learner can collect results and deep stats.
- The AI calibration will not activate until enough settled matches are stored.
- Use the Railway logs to confirm background jobs are running.
- If API-Football rate limits are reached, increase learner intervals in environment variables.
- Never commit `PREDICTION_AUDIT_SIGNING_KEY`. It seals prediction snapshots
  and final settlements with HMAC-SHA256. Without it, the Performance page
  fails closed and excludes all rows from certified headline figures.
- Migration `007_tamper_evident_prediction_audit.sql` prevents prediction edits,
  repeat settlement and deletion at database level. Do not rotate the signing
  key casually: the current version intentionally treats older signatures as
  unverified after a rotation.
