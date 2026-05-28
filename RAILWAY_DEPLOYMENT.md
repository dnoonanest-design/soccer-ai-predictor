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
```

Railway PostgreSQL normally provides `DATABASE_URL` automatically. If it does not, copy the PostgreSQL connection string into a variable called `DATABASE_URL`.

## 3. Database migration

After the first deploy, open the Railway service shell and run:

```bash
pnpm run migrate
```

This applies:

```bash
db/001_prediction_platform.sql
```

## 4. Build/start commands

Railway should detect `railway.toml` automatically.

Build command:

```bash
corepack enable && corepack prepare pnpm@9.15.9 --activate && pnpm install --frozen-lockfile && pnpm run railway:build
```

Start command:

```bash
pnpm run railway:start
```

Health check:

```text
/api/healthz
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
