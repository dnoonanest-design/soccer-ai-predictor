# Fixes applied

This corrected export includes the following runtime fixes:

1. Vite web apps now default to `PORT=3000` and `BASE_PATH=/` instead of crashing when those environment variables are missing.
2. The Expo/mobile app no longer builds an invalid API URL like `https://undefined`. It now uses `EXPO_PUBLIC_API_URL`, then `EXPO_PUBLIC_DOMAIN`, then `http://localhost:3000`.
3. Enhanced prediction percentages are kept as 0-100 values for the UI, fixing displays such as `0.45%` instead of `45%`.
4. Prediction calibration and Brier score calculations now tolerate both older 0-1 saved probabilities and corrected 0-100 probabilities.
5. Pretty logging is disabled by default unless `PRETTY_LOGS=true`, avoiding the portable-build Pino worker path problem after exporting from Replit.
6. Added `.env.example` showing the required environment variables without storing real secrets.

## Recommended setup in Replit

Add these in Replit Secrets:

- `DATABASE_URL`
- `API_FOOTBALL_KEY`
- `ODDS_API_KEY` if you use bookmaker odds
- `PORT=3000` if Replit does not set it automatically
- `BASE_PATH=/`

Then run:

```bash
pnpm install
pnpm --filter @workspace/api-server run build
pnpm --filter @workspace/api-server run start
```

For the dashboard:

```bash
pnpm --filter @workspace/soccer-dashboard run dev
```

If you want pretty local logs, set `PRETTY_LOGS=true` only after dependencies are installed.
