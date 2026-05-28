# Deep error, accuracy and speed check

Applied fixes after full review:

- API start script now rebuilds before running so Replit does not serve a stale bundled server.
- Root `pnpm start` added for easier deployment.
- Auto-calibration now refuses to activate until enough settled samples exist. Default minimum: 60.
- Circumstance probability normalisation now always totals 100% and avoids negative/NaN values.
- AI memory consolidation now avoids duplicate audit memories by using unique audit source keys.
- Biweekly update duplicate detection now checks overlapping update windows.
- Background learner environment controls added to `.env.example`.

Performance notes:

- Live deep stats are capped by `BACKGROUND_MAX_LIVE_MATCHES` to reduce API load.
- Circumstance API calls are cached using `CIRCUMSTANCE_CACHE_MS`.
- Training/calibration is guarded by sample size to avoid noisy accuracy updates.

Run before use:

```bash
pnpm install
pnpm run build
```

Then run the SQL migration:

```sql
db/001_prediction_platform.sql
```
